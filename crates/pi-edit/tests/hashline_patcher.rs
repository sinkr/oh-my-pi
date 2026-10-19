mod common;

use pi_edit::{
	EditMode, ModeEngine,
	modes::hashline::{
		HashlineEngine,
		patcher::{no_change_diagnostic, no_change_loop_diagnostic},
	},
	stream_json::ArgSnapshot,
};
use serde_json::json;

#[tokio::test]
async fn patcher_apply_cases() {
	common::run_fixture("hashline/patcher.json", EditMode::Hashline).await;
}

#[test]
fn matcher_paths_accept_partial_sections_and_header_noise() {
	let engine = HashlineEngine { enforce_seen_lines: false, max_columns: 512 };
	let inspected = engine.inspect(&ArgSnapshot {
		input: Some(
			"[one.ts#ABCD]\nPUT 1.=1:\n+one\n[*** Update File: dir with spaces/two.ts#1234]\nPUT \
			 2.=2:\n+two"
				.into(),
		),
		..ArgSnapshot::default()
	});
	assert_eq!(inspected.paths, ["one.ts", "dir with spaces/two.ts"]);
	assert_eq!(inspected.entries, [
		("one.ts".into(), "one".into()),
		("dir with spaces/two.ts".into(), "two".into())
	]);
}

#[test]
fn no_op_diagnostics_preserve_model_guidance() {
	assert_eq!(
		no_change_diagnostic("a.ts"),
		"Edits to a.ts parsed and applied cleanly, but produced no change: your body row(s) are \
		 byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the \
		 file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor \
		 first."
	);
	assert!(
		no_change_loop_diagnostic("a.ts", 3)
			.starts_with("STOP. Edits to a.ts have been a byte-identical no-op 3 times in a row")
	);
}

#[tokio::test]
async fn identical_noop_escalates_on_third_attempt() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "same\n");
	let tag = workspace.snapshot("a.txt", "same\n", None);
	let args = json!({ "input": format!("[a.txt#{tag}]\nPUT 1.=1:\n+same") });
	for _ in 0..2 {
		let outcome = workspace
			.apply_json(&args, &common::DiskWriter::default())
			.await
			.expect("soft no-op");
		assert!(outcome.text.contains("produced no change"));
	}
	let error = workspace
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect_err("third no-op must fail");
	assert!(
		error
			.to_string()
			.starts_with("STOP. Edits to a.txt have been a byte-identical no-op 3 times in a row")
	);
}

#[test]
fn streaming_preview_keeps_completed_section_when_trailing_header_arrives() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	workspace.write("b.txt", "b\n");
	let tag_a = workspace.snapshot("a.txt", "a\n", None);
	let tag_b = workspace.snapshot("b.txt", "b\n", None);
	let input = format!("[a.txt#{tag_a}]\nPUT 1.=1:\n+A\n[b.txt#{tag_b}]");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": input }).to_string());
	let batch = session.preview();
	assert!(batch.streaming);
	assert_eq!(batch.files.len(), 1);
	assert_eq!(batch.files[0].display, "a.txt");
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("+1|A"))
	);
}

#[tokio::test]
async fn rejection_names_the_path_a_foreign_tag_was_issued_for() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let worktree = workspace.write("wt/crates/a/mcp.rs", "worktree\n");
	workspace.write("crates/a/mcp.rs", "parent\n");
	let tag = workspace.snapshot("wt/crates/a/mcp.rs", "worktree\n", None);
	let writer = common::DiskWriter::default();
	let input = format!("[crates/a/mcp.rs#{tag}]\nPUT 1.=1:\n+changed\n");
	let error = workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect_err("foreign tag must be rejected")
		.to_string();
	let origin = pi_edit::path_policy::canonical_key(&worktree);
	assert!(
		error.contains(&format!("Hash #{tag} was issued in this session for {}.", origin.display())),
		"{error}"
	);
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("crates/a/mcp.rs").as_deref(), Some("parent\n"));
	assert_eq!(workspace.read("wt/crates/a/mcp.rs").as_deref(), Some("worktree\n"));
}

const UNTAGGED_TEXT: &str = "alpha\nbeta\ngamma\n";

#[tokio::test]
async fn untagged_sections_get_the_current_tag_like_an_unknown_one() {
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	for header in ["a.txt#AUTO", "a.txt#????", "a.txt#", "a.txt#PLACEHOLDER", "a.txt"] {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write("a.txt", UNTAGGED_TEXT);
		let writer = common::DiskWriter::default();
		let error = workspace
			.apply_json(&json!({ "input": format!("[{header}]\nPUT 2.=2:\n+BETA\n") }), &writer)
			.await
			.expect_err("an untagged section must not apply")
			.to_string();
		assert!(
			error.contains(&format!("the header needs this file's current tag, #{current}.")),
			"{header}: {error}"
		);
		assert!(
			error.contains(&format!("The current file hashes to #{current}.")),
			"{header}: {error}"
		);
		assert!(error.contains("*2:beta"), "{header}: {error}");
		assert!(writer.requests.lock().is_empty(), "{header}");
		assert_eq!(workspace.read("a.txt").as_deref(), Some(UNTAGGED_TEXT), "{header}");

		// The returned tag is enough to apply the same body without a read.
		workspace
			.apply_json(&json!({ "input": format!("[a.txt#{current}]\nPUT 2.=2:\n+BETA\n") }), &writer)
			.await
			.expect("resend with the returned tag");
		assert_eq!(workspace.read("a.txt").as_deref(), Some("alpha\nBETA\ngamma\n"), "{header}");
	}
}

#[tokio::test]
async fn untagged_head_and_tail_inserts_do_not_apply() {
	// An unknown hex tag lets a `PUT >$:` through with a drift warning; a
	// section with no tag at all never applies.
	for header in ["a.txt#AUTO", "a.txt"] {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write("a.txt", UNTAGGED_TEXT);
		let error = workspace
			.apply_json(
				&json!({ "input": format!("[{header}]\nPUT >$:\n+delta\n") }),
				&common::DiskWriter::default(),
			)
			.await
			.expect_err("an untagged append must not apply")
			.to_string();
		assert!(error.contains("the header needs this file's current tag"), "{header}: {error}");
		assert_eq!(workspace.read("a.txt").as_deref(), Some(UNTAGGED_TEXT), "{header}");
	}
}

#[tokio::test]
async fn header_only_input_gets_the_current_tag() {
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	for header in [
		"[a.txt#AUTO]",
		"[a.txt#0000]",
		"[a.txt]",
		&format!("[a.txt#{current}]"),
		"\u{feff}[a.txt#AUTO]",
		&format!("\u{feff}[a.txt#{current}]"),
	] {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write("a.txt", UNTAGGED_TEXT);
		let writer = common::DiskWriter::default();
		let error = workspace
			.apply_json(&json!({ "input": format!("{header}\n") }), &writer)
			.await
			.expect_err("a header with no ops must not apply")
			.to_string();
		assert!(
			error.starts_with(&format!(
				"Edit rejected for a.txt: no ops follow the header; put them under this file's \
				 current tag, #{current}."
			)),
			"{header}: {error}"
		);
		assert!(
			error.contains(&format!("The current file hashes to #{current}.")),
			"{header}: {error}"
		);
		assert!(writer.requests.lock().is_empty(), "{header}");
	}
}

#[tokio::test]
async fn placeholder_section_does_not_borrow_a_same_path_tag() {
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	for placeholder in ["AUTO", "????", ""] {
		for input in [
			format!("[a.txt#{placeholder}]\nPUT 1.=1:\n+A\n[a.txt#{current}]\nPUT 2.=2:\n+B\n"),
			format!("[a.txt#{current}]\nPUT 1.=1:\n+A\n[a.txt#{placeholder}]\nPUT 2.=2:\n+B\n"),
		] {
			let workspace = common::Workspace::new(EditMode::Hashline);
			workspace.write("a.txt", UNTAGGED_TEXT);
			let writer = common::DiskWriter::default();
			let error = workspace
				.apply_json(&json!({ "input": input }), &writer)
				.await
				.expect_err("a placeholder section must not apply under another header's tag")
				.to_string();
			assert!(
				error.contains(&format!("the header needs this file's current tag, #{current}.")),
				"{input}: {error}"
			);
			assert!(writer.requests.lock().is_empty(), "{input}");
			assert_eq!(workspace.read("a.txt").as_deref(), Some(UNTAGGED_TEXT), "{input}");
		}
	}
}

#[tokio::test]
async fn untagged_section_for_a_missing_file_points_at_write() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	for input in
		["[new.txt#AUTO]\nPUT 1.=1:\n+x\n", "[new.txt]\nPUT 1.=1:\n+x\n", "[new.txt#????]\n"]
	{
		let error = workspace
			.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
			.await
			.expect_err("missing file")
			.to_string();
		assert_eq!(
			error, "File not found: new.txt. Use the write tool to create new files.",
			"{input}"
		);
	}
}

#[test]
fn completed_preview_surfaces_the_current_tag_for_an_untagged_section() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", UNTAGGED_TEXT);
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": "[a.txt#AUTO]\nPUT 1.=1:\n+A\n" }).to_string());
	session.finish();
	let batch = session.preview();
	let current = pi_edit::store::file_hash(UNTAGGED_TEXT);
	let error = batch.files[0].error.as_deref().unwrap_or_default();
	assert!(error.contains(&format!("The current file hashes to #{current}.")), "{error}");
}

#[tokio::test]
async fn recovered_rem_reports_authored_and_deleted_paths() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let target = workspace.write("correct/target.ts", "const value = 1;\n");
	let tag = workspace.snapshot("correct/target.ts", "const value = 1;\n", None);
	let input = format!("[wrong/target.ts#{tag}]\nREM\n");
	let outcome = workspace
		.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
		.await
		.expect("recovered delete");

	assert!(!target.exists());
	let deleted = pi_edit::path_policy::canonical_key(&target);
	assert!(
		outcome
			.text
			.contains(&format!("Deleted {}", deleted.display())),
		"{}",
		outcome.text
	);
	assert!(
		outcome.text.contains(&format!(
			"Warnings:\nPath \"wrong/target.ts\" does not exist; matched its filename and snapshot \
			 tag #{tag} to {}",
			deleted.display()
		)),
		"{}",
		outcome.text
	);
}

#[test]
fn completed_preview_surfaces_stale_hash_error() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": "[a.txt#FFFF]\nPUT 1.=1:\n+A\n" }).to_string());
	session.finish();
	let batch = session.preview();
	assert!(!batch.streaming);
	assert!(
		batch.files[0]
			.error
			.as_deref()
			.is_some_and(|error| error.contains("not from this session"))
	);
}

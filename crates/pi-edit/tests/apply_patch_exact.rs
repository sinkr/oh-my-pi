mod common;

use pi_edit::EditMode;

fn update(body: &str) -> String {
	format!("*** Begin Patch\n*** Update File: fixture.txt\n{body}\n*** End Patch")
}

#[tokio::test]
async fn rejects_materially_unmatched_lines_without_writes() {
	for (before, body) in [
		("{\n    \"sha\": \"a\",\n    \"ref\": \"b\"\n}\n", "@@\n-    sha=\"a\",\n-    ref=\"b\"\n+    sha=\"c\",\n+    ref=\"d\""),
		("void configure(int first, int middle, int last);\n", "@@\n-void configure(int first, int last);\n+void configure(int first, int last, bool enabled);"),
		("def configure(\n    first,\n    middle,\n    last,\n):\n    pass\n", "@@\n def configure(\n     first,\n-    last,\n+    final,\n ):"),
		("// named states\n", "@@\n-named states\n+79 named states"),
		("69 named states\n", "@@\n-named states\n+79 named states"),
		("void configure(int first, int middle);\n    run();\n", "@@ void configure(int first);\n-    run();\n+    stop();"),
		("unrelated header\nold\n", "@@\n absent header\n-old\n+new"),
	] {
		let mut workspace = common::Workspace::new(EditMode::ApplyPatch);
		workspace.config.fuzzy_threshold = 0.8;
		workspace.write("fixture.txt", before);
		let input = update(body);
		let mut session = workspace.session();
		session.set_args_json(&serde_json::json!({"input": input}).to_string());
		session.finish();
		let preview = session.preview();
		assert!(preview.files[0].error.is_some(), "preview accepted {body}");
		let writer = common::DiskWriter::default();
		let result = workspace.apply_raw(&input, &writer).await;
		assert!(result.is_err(), "applied unmatched lines: {body}");
		assert!(writer.requests.lock().is_empty());
		assert_eq!(workspace.read("fixture.txt").as_deref(), Some(before));
	}
}

#[tokio::test]
async fn matches_only_complete_lines_through_codex_normalization_passes() {
	for (before, body, expected) in [
		("69 named states\n", "@@\n-69 named states\n+79 named states", "79 named states\n"),
		("old   \n", "@@\n-old\n+new", "new\n"),
		("    old\n", "@@\n-old\n+new", "    new\n"),
		("", "@@\n+first", "first"),
		("head", "@@\n+tail", "head\ntail"),
		("message = \"hello – world\"\n", "@@\n-message = \"hello - world\"\n+message = \"goodbye\"", "message = \"goodbye\"\n"),
		("old\nold\n", "@@\n-old\n+first\n@@\n-old\n+second", "first\nsecond\n"),
	] {
		let workspace = common::Workspace::new(EditMode::ApplyPatch);
		workspace.write("fixture.txt", before);
		workspace.apply_raw(&update(body), &common::DiskWriter::default()).await.unwrap();
		assert_eq!(workspace.read("fixture.txt").as_deref(), Some(expected));
	}
}

#[tokio::test]
async fn wrong_context_in_a_later_file_rejects_the_entire_envelope() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	workspace.write("first.txt", "before\n");
	workspace.write("fixture.txt", "void configure(int first, int middle, int last);\n");
	let input = "*** Begin Patch\n*** Update File: first.txt\n@@\n-before\n+after\n*** Update File: fixture.txt\n@@\n-void configure(int first, int last);\n+void configure(int first, int last, bool enabled);\n*** End Patch";
	let writer = common::DiskWriter::default();
	assert!(workspace.apply_raw(input, &writer).await.is_err());
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("first.txt").as_deref(), Some("before\n"));
	assert_eq!(workspace.read("fixture.txt").as_deref(), Some("void configure(int first, int middle, int last);\n"));
}

#[tokio::test]
async fn line_deletion_removes_its_terminator_and_preserves_other_empty_lines() {
	for ending in ["\n", "\r\n"] {
		for final_newline in [false, true] {
			for (lines, index) in [
				(vec!["first", "remove", "last"], 1),
				(vec!["remove", "middle", "last"], 0),
				(vec!["first", "middle", "remove"], 2),
				(vec!["remove"], 0),
				(vec!["first", "", "remove", "", "last"], 2),
			] {
				let mut before = lines.join(ending);
				if final_newline {
					before.push_str(ending);
				}
				let mut remaining = lines;
				remaining.remove(index);
				let mut expected = remaining.join(ending);
				if final_newline && !remaining.is_empty() {
					expected.push_str(ending);
				}
				let workspace = common::Workspace::new(EditMode::ApplyPatch);
				let path = workspace.write("fixture.txt", &before);
				workspace.apply_raw(&update("@@\n-remove"), &common::DiskWriter::default()).await.unwrap();
				assert_eq!(std::fs::read(path).unwrap(), expected.as_bytes(), "{before:?}");
			}
		}
	}
}

#[tokio::test]
async fn deleting_an_import_line_does_not_leave_an_empty_row() {
	let workspace = common::Workspace::new(EditMode::ApplyPatch);
	let path = workspace.write("fixture.txt", "from x import (\n    A,\n    B,\n)\n");
	workspace.apply_raw(&update("@@\n-    A,"), &common::DiskWriter::default()).await.unwrap();
	assert_eq!(std::fs::read(&path).unwrap(), b"from x import (\n    B,\n)\n");
	workspace.apply_raw(&update("@@\n-    B,\n+    C,"), &common::DiskWriter::default()).await.unwrap();
	assert_eq!(std::fs::read(path).unwrap(), b"from x import (\n    C,\n)\n");
}

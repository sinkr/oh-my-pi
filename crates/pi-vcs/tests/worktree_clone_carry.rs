use std::{
	collections::BTreeMap,
	fs,
	path::{Path, PathBuf},
	process::Command,
};

use pi_vcs::{
	git::GitRepo,
	types::{WorktreeAddOptions, WorktreeClone},
};
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
	let output = Command::new("git")
		.arg("-C")
		.arg(dir)
		.args(args)
		.output()
		.unwrap();
	assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
	String::from_utf8(output.stdout)
		.unwrap()
		.trim_end()
		.to_owned()
}

fn write(root: &Path, relative: &str, contents: &str) {
	let path = root.join(relative);
	fs::create_dir_all(path.parent().unwrap()).unwrap();
	fs::write(path, contents).unwrap();
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
	fn visit(root: &Path, dir: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
		for entry in fs::read_dir(dir).unwrap() {
			let entry = entry.unwrap();
			if entry.file_name() == ".git" {
				continue;
			}
			let path = entry.path();
			let kind = entry.file_type().unwrap();
			if kind.is_dir() {
				visit(root, &path, files);
			} else {
				let bytes = if kind.is_symlink() {
					fs::read_link(&path)
						.unwrap()
						.as_os_str()
						.as_encoded_bytes()
						.to_vec()
				} else {
					fs::read(&path).unwrap()
				};
				files.insert(path.strip_prefix(root).unwrap().to_path_buf(), bytes);
			}
		}
	}
	let mut files = BTreeMap::new();
	visit(root, root, &mut files);
	files
}

fn fixture() -> (TempDir, PathBuf, GitRepo) {
	let temp = tempfile::tempdir().unwrap();
	let source = temp.path().join("source");
	fs::create_dir(&source).unwrap();
	git(&source, &["init", "-q", "-b", "main"]);
	for (key, value) in [
		("user.name", "Test"),
		("user.email", "test@example.com"),
		("commit.gpgsign", "false"),
		("core.autocrlf", "false"),
		("core.hooksPath", ".git/hooks"),
	] {
		git(&source, &["config", key, value]);
	}
	write(&source, "a.txt", "tracked\n");
	write(&source, ".gitignore", "node_modules/\n");
	git(&source, &["add", "."]);
	git(&source, &["commit", "-qm", "base"]);
	write(&source, "node_modules/pkg/index.js", "relocatable cache\n");
	let repo = GitRepo::require(&source).unwrap();
	(temp, source, repo)
}

fn clone_works_on(root: &Path) -> bool {
	let source = root.join("clone-probe-source");
	let target = root.join("clone-probe-target");
	write(&source, "file", "probe\n");
	let works = pi_iso::clone_candidates(None).into_iter().any(|kind| {
		let _ = fs::remove_dir_all(&target);
		pi_iso::backend(kind)
			.clone_tree(&source, &target, &[])
			.is_ok()
	});
	fs::remove_dir_all(source).unwrap();
	let _ = fs::remove_dir_all(target);
	works
}

#[test]
fn clone_excludes_self_ignored_environments_and_nested_cmake_caches() {
	let (temp, source, repo) = fixture();
	if !clone_works_on(temp.path()) {
		eprintln!("SKIP: no working clone backend on this filesystem");
		return;
	}
	let environments = [".venv", ".venv-wt", "custom-python", "apps/api/environment"];
	let script = format!("#!{}/.venv/bin/python\n", source.display());
	for dir in environments {
		write(&source, &format!("{dir}/.gitignore"), "*\n");
		write(&source, &format!("{dir}/pyvenv.cfg"), "home = /source/python\n");
		write(&source, &format!("{dir}/bin/pytest"), &script);
	}
	for dir in ["build", "apps/native/build"] {
		write(&source, &format!("{dir}/.gitignore"), "*\n");
		write(
			&source,
			&format!("{dir}/CMakeCache.txt"),
			&format!("CMAKE_HOME_DIRECTORY:INTERNAL={}\n", source.display()),
		);
		write(&source, &format!("{dir}/artifact"), "source-only build\n");
	}
	let source_before = snapshot(&source);
	let target = temp.path().join("target");
	let result = repo
		.worktree_add(&target, "HEAD", WorktreeAddOptions {
			detach:       true,
			clone:        WorktreeClone::Auto,
			keep_changes: false,
		})
		.unwrap();
	assert!(result.cloned_with.is_some(), "{:?}", result.clone_error);
	for dir in environments
		.into_iter()
		.chain(["build", "apps/native/build"])
	{
		assert!(!target.join(dir).exists(), "nonrelocatable directory {dir} was carried");
	}
	assert_eq!(fs::read_to_string(source.join(".venv/bin/pytest")).unwrap(), script);
	assert_eq!(
		fs::read_to_string(target.join("node_modules/pkg/index.js")).unwrap(),
		"relocatable cache\n"
	);
	assert_eq!(git(&target, &["status", "--porcelain", "--untracked-files=all"]), "");
	assert_eq!(snapshot(&source), source_before, "source files changed during clone reconciliation");
}

#[test]
fn clone_exclusion_keeps_tracked_data_and_keep_changes_state() {
	for keep_changes in [false, true] {
		let (temp, source, repo) = fixture();
		if !clone_works_on(temp.path()) {
			eprintln!("SKIP: no working clone backend on this filesystem");
			return;
		}
		write(&source, "tooling/pyvenv.cfg", "tracked configuration\n");
		write(&source, "tooling/config.txt", "committed\n");
		git(&source, &["add", "tooling"]);
		git(&source, &["commit", "-qm", "track environment data"]);
		write(&source, "tooling/.gitignore", "*\n");
		write(&source, "tooling/bin/pytest", "#!/source/python\n");
		write(&source, "tooling/config.txt", "staged\n");
		git(&source, &["add", "tooling/config.txt"]);
		write(&source, "tooling/config.txt", "staged then edited\n");
		let source_before = snapshot(&source);
		let target = temp.path().join("target");
		let result = repo
			.worktree_add(&target, "HEAD", WorktreeAddOptions {
				detach: true,
				clone: WorktreeClone::Auto,
				keep_changes,
			})
			.unwrap();
		assert!(result.cloned_with.is_some(), "{:?}", result.clone_error);
		assert!(!target.join("tooling/bin/pytest").exists(), "source-bound script was carried");
		assert_eq!(
			fs::read_to_string(target.join("tooling/pyvenv.cfg")).unwrap(),
			"tracked configuration\n"
		);
		assert_eq!(
			fs::read_to_string(target.join("tooling/config.txt")).unwrap(),
			if keep_changes { "staged then edited\n" } else { "committed\n" }
		);
		assert_eq!(
			git(&target, &["show", ":tooling/config.txt"]),
			if keep_changes { "staged" } else { "committed" }
		);
		assert_eq!(fs::read_to_string(source.join("tooling/bin/pytest")).unwrap(), "#!/source/python\n");
		assert_eq!(snapshot(&source), source_before, "source files changed during clone reconciliation");
	}
}

#[test]
fn clone_disabled_or_unavailable_uses_an_ordinary_checkout() {
	for clone in [WorktreeClone::Off, WorktreeClone::Auto] {
		let (temp, source, repo) = fixture();
		write(&source, ".venv/.gitignore", "*\n");
		write(&source, ".venv/pyvenv.cfg", "home = /source/python\n");
		if clone == WorktreeClone::Auto {
			fs::remove_file(source.join(".git/index")).unwrap();
		}
		let source_before = snapshot(&source);
		let target = temp.path().join("target");
		let result = repo
			.worktree_add(&target, "HEAD", WorktreeAddOptions {
				detach: true,
				clone,
				keep_changes: false,
			})
			.unwrap();
		assert!(result.cloned_with.is_none());
		assert_eq!(fs::read_to_string(target.join("a.txt")).unwrap(), "tracked\n");
		assert!(!target.join(".venv").exists());
		assert!(!target.join("node_modules").exists());
		assert_eq!(git(&target, &["status", "--porcelain"]), "");
		assert_eq!(snapshot(&source), source_before);
	}
}

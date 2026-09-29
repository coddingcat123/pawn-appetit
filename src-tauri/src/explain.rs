//! Shells out to `chess-repertoire explain` (a separate Python tool,
//! github.com/teo/chess-repertoire) for one ad-hoc position's deep report -- verdict
//! terms, structural facts, NNUE network internals with per-square attribution. A
//! one-shot call-and-capture, not a persistent stdin/stdout UCI session -- there's no
//! ongoing conversation here, just one FEN in, one JSON line out.
//!
//! `chess-repertoire` prints exactly one line of JSON to stdout (matching this app's
//! own `CandidateReportData` TS type -- see `src/utils/richReport.ts`) and sends any
//! provisioning/warning noise to stderr instead, so a non-zero exit or unparseable
//! stdout is a real, reportable failure, not something to silently paper over.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Deserialize;
use specta::Type;
use tokio::process::Command;

use crate::error::Error;

/// `chess-repertoire`'s own settings (`interpretability_artifacts_dir`,
/// `classical_engine_binary_dir`, etc.) default to paths *relative to the process's
/// current working directory* -- fine when the tool is run directly from its own
/// project root, but this command spawns the binary with whatever CWD the Tauri app
/// happens to have, which is never that. Confirmed directly: running the same `explain`
/// invocation from an unrelated directory silently drops all NNUE network-internals
/// data (`"nnue: no trained SAE found"`, sent to stderr) even though a trained SAE
/// exists right where the project expects it. Rather than changing chess-repertoire's
/// own settings resolution (wider blast radius, affects every command and every
/// caller, not just this one), infer the project root from the binary's own path --
/// `<project_root>/.venv/bin/<script>` is the standard venv layout -- and run the
/// subprocess from there. Falls back to not setting a working directory at all (today's
/// behavior) if that layout doesn't hold, rather than guessing wrong and breaking a
/// binary that isn't installed this way.
fn infer_project_root(binary_path: &str) -> Option<PathBuf> {
    let project_root = Path::new(binary_path).parent()?.parent()?.parent()?;
    project_root.is_dir().then(|| project_root.to_path_buf())
}

#[derive(Deserialize, Debug, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExplainOptions {
    pub multipv: Option<u32>,
    pub depth: Option<u32>,
    pub classical_eval: Option<bool>,
    pub branch_alternatives: Option<bool>,
    pub interpretability: Option<bool>,
    pub depth_series: Option<bool>,
    /// Guarantees this move gets explained even if it isn't one of the engine's own
    /// top-N MultiPV choices (e.g. the move actually continued with in the game).
    pub played_move_uci: Option<String>,
    pub branch_depth: Option<u32>,
    pub branch_multipv: Option<u32>,
    /// How many top-firing network-internals features to report per network --
    /// `report.py`'s own compact default (3) is tuned for a PGN comment, not an
    /// interactive panel with room to show more.
    pub feature_top_k: Option<u32>,
}

fn push_flag(args: &mut Vec<String>, name: &str, value: Option<bool>) {
    if let Some(false) = value {
        args.push(format!("--no-{name}"));
    }
}

#[tauri::command]
#[specta::specta]
pub async fn explain_position(
    binary_path: String,
    fen: String,
    options: ExplainOptions,
) -> Result<String, Error> {
    let mut args = vec!["explain".to_string(), "--fen".to_string(), fen];

    if let Some(multipv) = options.multipv {
        args.push("--multipv".to_string());
        args.push(multipv.to_string());
    }
    if let Some(depth) = options.depth {
        args.push("--depth".to_string());
        args.push(depth.to_string());
    }
    push_flag(&mut args, "classical-eval", options.classical_eval);
    push_flag(&mut args, "branch-alternatives", options.branch_alternatives);
    push_flag(&mut args, "interpretability", options.interpretability);
    push_flag(&mut args, "depth-series", options.depth_series);
    if let Some(played_move_uci) = options.played_move_uci {
        args.push("--played-move-uci".to_string());
        args.push(played_move_uci);
    }
    if let Some(branch_depth) = options.branch_depth {
        args.push("--branch-depth".to_string());
        args.push(branch_depth.to_string());
    }
    if let Some(branch_multipv) = options.branch_multipv {
        args.push("--branch-multipv".to_string());
        args.push(branch_multipv.to_string());
    }
    if let Some(feature_top_k) = options.feature_top_k {
        args.push("--feature-top-k".to_string());
        args.push(feature_top_k.to_string());
    }

    let mut command = Command::new(&binary_path);
    command.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(project_root) = infer_project_root(&binary_path) {
        command.current_dir(project_root);
    }

    let output = command.output().await?;

    if !output.status.success() {
        return Err(Error::ExplainFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_flag_omits_when_none() {
        let mut args = vec![];
        push_flag(&mut args, "classical-eval", None);
        assert!(args.is_empty());
    }

    #[test]
    fn push_flag_omits_when_true() {
        // `--classical-eval` (the "on" flag) is the CLI default -- only the negative
        // `--no-X` form ever needs to be passed explicitly.
        let mut args = vec![];
        push_flag(&mut args, "classical-eval", Some(true));
        assert!(args.is_empty());
    }

    #[test]
    fn push_flag_adds_no_prefixed_flag_when_false() {
        let mut args = vec![];
        push_flag(&mut args, "classical-eval", Some(false));
        assert_eq!(args, vec!["--no-classical-eval".to_string()]);
    }

    #[test]
    fn infer_project_root_finds_it_for_a_standard_venv_layout() {
        let project = tempfile::tempdir().unwrap();
        let bin_dir = project.path().join(".venv").join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let binary_path = bin_dir.join("chess-repertoire");

        let root = infer_project_root(binary_path.to_str().unwrap());

        assert_eq!(root, Some(project.path().to_path_buf()));
    }

    #[test]
    fn infer_project_root_none_when_the_derived_path_does_not_exist() {
        assert_eq!(infer_project_root("/definitely/not/a/real/path/.venv/bin/chess-repertoire"), None);
    }

    #[test]
    fn infer_project_root_none_for_a_bare_command_with_no_parent_dirs() {
        // e.g. "chess-repertoire" found on PATH with no venv structure to infer from.
        assert_eq!(infer_project_root("chess-repertoire"), None);
    }
}

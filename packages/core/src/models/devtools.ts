/**
 * Software projects, as Atlas is allowed to inspect and act on them.
 *
 * This is the model behind the developer-agent surface: detecting what kind of
 * project a folder is, reading its git state, searching its text, and running
 * its build/test tooling. Every write or execution here follows the same rule
 * as the rest of the `Platform` port: a fixed executable, a closed set of
 * subcommands, and validated argument slots — never a variable command string.
 * See `devtools.rs`'s module doc for the full reasoning.
 */

/** One build/test ecosystem Atlas knows how to detect and drive. */
export type DevSystem = 'cmake' | 'cargo' | 'npm' | 'pnpm' | 'dotnet' | 'make' | 'pytest';

export interface ProjectInfo {
  root: string;
  /** Every ecosystem whose marker file was found — a project can have more than one. */
  systems: DevSystem[];
  /** `package.json`'s own `scripts` keys, when `npm`/`pnpm` was detected. Empty otherwise. */
  npmScripts: string[];
  isGitRepo: boolean;
  /** True when a CMake build directory (`build/CMakeCache.txt`) already exists. */
  cmakeConfigured: boolean;
}

export interface TreeEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  /** How deep under the requested root this entry sits. 0 = a direct child. */
  depth: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  /** The matching line, trimmed. Never the whole file. */
  text: string;
}

export interface GitStatus {
  branch: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  /** True when nothing is staged, unstaged or untracked. */
  clean: boolean;
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

/**
 * The exact command a build/test call will run, as a closed enum — never a
 * variable string. `runDevTool`'s `arg` fills one validated slot inside
 * whichever of these is named; it can never change which program runs.
 */
export type DevTool =
  | 'cmake-configure'
  | 'cmake-build'
  | 'ctest'
  | 'cargo-build'
  | 'cargo-test'
  | 'npm-run'
  | 'npm-test'
  | 'pnpm-run'
  | 'pnpm-test'
  | 'dotnet-build'
  | 'dotnet-test'
  | 'make-build'
  | 'pytest';

export interface ToolResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when stdout/stderr were cut off at the size cap. */
  truncated: boolean;
}

/**
 * The package managers `installDependency` knows how to drive — a closed
 * set, exactly like `DevTool` above. There is no variant that takes a raw
 * command line; the manager decides the fixed executable, `installDependency`
 * fills in one validated package-name slot.
 */
export type DepManager = 'npm' | 'pnpm' | 'cargo' | 'pip';

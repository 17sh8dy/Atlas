/**
 * What is using the space inside one folder — not named `storage.ts` on
 * purpose, so it is never confused with the `Storage` persistence port this
 * package also exports.
 */

export interface FolderSize {
  path: string;
  totalBytes: number;
  fileCount: number;
  folderCount: number;
  /** True when the walk hit its entry or time cap before finishing. */
  truncated: boolean;
}

export interface LargeFile {
  path: string;
  name: string;
  sizeBytes: number;
}

export interface LargestFiles {
  files: LargeFile[];
  truncated: boolean;
}

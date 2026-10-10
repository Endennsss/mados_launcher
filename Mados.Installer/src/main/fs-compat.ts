import * as nodeFs from "node:fs";

/** Electron's fs patch treats app.asar as a virtual archive. The installer
 * writes a real app.asar to disk, so use the unpatched implementation there. */
export const fs = (process.versions.electron ? require("original-fs") : nodeFs) as typeof nodeFs;
export const fsp = fs.promises;

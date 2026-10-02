export type LabKind = "browser_beef" | "secrets" | "web_generic" | "general";

export interface LabFile {
  path: string;
  content: string;
}

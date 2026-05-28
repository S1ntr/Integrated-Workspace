export interface FileIconInfo {
  icon: string;
  className: string;
  label: string;
}

const EXTENSION_ICONS: Record<string, FileIconInfo> = {
  html: { icon: "bxl-html5", className: "file-ext-html", label: "HTML" },
  htm: { icon: "bxl-html5", className: "file-ext-html", label: "HTML" },
  css: { icon: "bxl-css3", className: "file-ext-css", label: "CSS" },
  scss: { icon: "bxl-sass", className: "file-ext-scss", label: "SCSS" },
  sass: { icon: "bxl-sass", className: "file-ext-scss", label: "Sass" },
  js: { icon: "bxl-javascript", className: "file-ext-js", label: "JavaScript" },
  jsx: { icon: "bxl-react", className: "file-ext-react", label: "React" },
  ts: { icon: "bxl-typescript", className: "file-ext-ts", label: "TypeScript" },
  tsx: { icon: "bxl-react", className: "file-ext-react", label: "React TSX" },
  json: { icon: "bx-code-curly", className: "file-ext-json", label: "JSON" },
  md: { icon: "bxl-markdown", className: "file-ext-md", label: "Markdown" },
  markdown: { icon: "bxl-markdown", className: "file-ext-md", label: "Markdown" },
  py: { icon: "bxl-python", className: "file-ext-py", label: "Python" },
  rs: { icon: "bx-code-alt", className: "file-ext-rs", label: "Rust" },
  toml: { icon: "bx-cog", className: "file-ext-config", label: "TOML" },
  yaml: { icon: "bx-cog", className: "file-ext-config", label: "YAML" },
  yml: { icon: "bx-cog", className: "file-ext-config", label: "YAML" },
  xml: { icon: "bx-code-alt", className: "file-ext-html", label: "XML" },
  svg: { icon: "bx-shape-polygon", className: "file-ext-image", label: "SVG" },
  png: { icon: "bx-image", className: "file-ext-image", label: "Image" },
  jpg: { icon: "bx-image", className: "file-ext-image", label: "Image" },
  jpeg: { icon: "bx-image", className: "file-ext-image", label: "Image" },
  gif: { icon: "bx-image", className: "file-ext-image", label: "Image" },
  webp: { icon: "bx-image", className: "file-ext-image", label: "Image" },
  ico: { icon: "bx-image", className: "file-ext-image", label: "Icon" },
  lock: { icon: "bx-lock-alt", className: "file-ext-lock", label: "Lockfile" },
  gitignore: { icon: "bxl-git", className: "file-ext-git", label: "Git" },
  dockerfile: { icon: "bxl-docker", className: "file-ext-docker", label: "Docker" },
};

export function getFileExtension(fileName: string): string {
  const normalized = fileName.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "dockerfile") return "dockerfile";
  if (normalized === ".gitignore") return "gitignore";
  if (normalized.endsWith("lock")) return "lock";
  const parts = normalized.split(".");
  return parts.length > 1 ? parts.pop() || "" : "";
}

export function getFileIcon(fileName: string): FileIconInfo {
  const ext = getFileExtension(fileName);
  return EXTENSION_ICONS[ext] || { icon: "bx-file-blank", className: "file-ext-default", label: "File" };
}

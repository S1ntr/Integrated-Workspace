import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { computeLineDiff, DiffLine } from "./ChangesViewer";
import { getFileExtension, getFileIcon } from "../utils/fileIcons";

interface FileViewerDialogProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
  baselineContent?: string;
}

// ─── High-Performance Regex Syntax Highlighter (Placeholder-Based to avoid Double-Highlighting) ───
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function tokenIndex(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function highlightToken(kind: string, index: number): string {
  return `___${kind}_${tokenIndex(index)}___`;
}

function applyCssHighlight(content: string): string {
  let r = content;
  const comments: string[] = [];
  r = r.replace(/\/\*[\s\S]*?\*\//g, (m) => {
    comments.push(`<span class="hl-comment">${m}</span>`);
    return highlightToken("_CC", comments.length - 1);
  });
  const strings: string[] = [];
  r = r.replace(/(".*?"|'.*?')/g, (m) => {
    strings.push(`<span class="hl-string">${m}</span>`);
    return highlightToken("_CS", strings.length - 1);
  });
  r = r
    .replace(/([a-zA-Z0-9.#*@:\[\]=_-]+)\s*(\{)/g, '<span class="hl-keyword">$1</span> $2')
    .replace(/([a-zA-Z0-9-]+)\s*:/g, '<span class="hl-attr">$1</span>:')
    .replace(/(#[a-fA-F0-9]{3,8})/g, '<span class="hl-number">$&</span>')
    .replace(/\b(\d+(?:px|em|rem|%|vh|vw|ms|s|deg)?)\b/g, '<span class="hl-number">$&</span>');
  for (let i = 0; i < strings.length; i++) r = r.replace(highlightToken("_CS", i), strings[i]);
  for (let i = 0; i < comments.length; i++) r = r.replace(highlightToken("_CC", i), comments[i]);
  return r;
}

function applyJsHighlight(content: string): string {
  let r = content;
  const comments: string[] = [];
  r = r
    .replace(/\/\*[\s\S]*?\*\//g, (m) => { comments.push(`<span class="hl-comment">${m}</span>`); return highlightToken("_JC", comments.length - 1); })
    .replace(/\/\/.*$/gm, (m) => { comments.push(`<span class="hl-comment">${m}</span>`); return highlightToken("_JC", comments.length - 1); });
  const strings: string[] = [];
  r = r
    .replace(/"(\\.|[^"\\])*"/g, (m) => { strings.push(`<span class="hl-string">${m}</span>`); return highlightToken("_JS", strings.length - 1); })
    .replace(/'(\\.|[^'\\])*'/g, (m) => { strings.push(`<span class="hl-string">${m}</span>`); return highlightToken("_JS", strings.length - 1); })
    .replace(/`([\s\S]*?)`/g, (m) => { strings.push(`<span class="hl-string">${m}</span>`); return highlightToken("_JS", strings.length - 1); });
  r = r
    .replace(/\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|class|interface|export|import|from|as|extends|new|this|typeof|instanceof|void|async|await)\b/g, '<span class="hl-keyword">$&</span>')
    .replace(/\b(string|number|boolean|any|object|null|undefined|true|false|NaN|Infinity)\b/g, '<span class="hl-type">$&</span>')
    .replace(/\b(0x[a-fA-F0-9]+|\d+(?:\.\d*)?)\b/g, '<span class="hl-number">$&</span>');
  for (let i = 0; i < strings.length; i++) r = r.replace(highlightToken("_JS", i), strings[i]);
  for (let i = 0; i < comments.length; i++) r = r.replace(highlightToken("_JC", i), comments[i]);
  return r;
}

function highlightHtmlTagStr(tag: string): string {
  return tag.replace(/(&lt;\/?[a-zA-Z0-9:-]+)([\s\S]*?)(&gt;)/g, (_m, p1, p2, p3) => {
    const attrs = p2.replace(/([a-zA-Z0-9:-]+)\s*=\s*(".*?"|'.*?'|[^\s>]+)/g, (_ma: string, aName: string, aVal: string) =>
      `<span class="hl-attr">${aName}</span>=<span class="hl-string">${aVal}</span>`);
    return `<span class="hl-tag">${p1}</span>${attrs}<span class="hl-tag">${p3}</span>`;
  });
}

export function highlightCode(
  code: string,
  fileName: string,
  searchQuery?: string,
  activeMatchIndex?: number
): string {
  let escaped = escapeHtml(code);
  
  // 1. Extract search matches to placeholders first if a search query is active
  const searchMatches: string[] = [];
  if (searchQuery && searchQuery.trim().length > 0) {
    const escapedQuery = escapeHtml(searchQuery);
    const regex = new RegExp(escapedQuery.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
    escaped = escaped.replace(regex, (match) => {
      searchMatches.push(match);
      return highlightToken("SEARCH", searchMatches.length - 1);
    });
  }

  let result = escaped;
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  if (ext === "json") {
    // 1. Extract strings (both keys and values) to prevent double-matching
    const strings: string[] = [];
    const isKey: boolean[] = [];
    result = result.replace(/("(\\u[a-zA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?/g, (_match, p1, _p2, p3) => {
      strings.push(p1);
      isKey.push(!!p3);
      return `${highlightToken("STR", strings.length - 1)}${p3 || ""}`;
    });

    // 2. Highlight numbers, booleans, nulls
    result = result
      .replace(/\b(-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\b/g, '<span class="hl-number">$1</span>')
      .replace(/\b(true|false|null)\b/g, '<span class="hl-type">$1</span>');

    // 3. Restore strings with correct classes
    for (let i = 0; i < strings.length; i++) {
      const cls = isKey[i] ? "hl-keyword" : "hl-string";
      result = result.replace(highlightToken("STR", i), `<span class="${cls}">${strings[i]}</span>`);
    }
  } else if (ext === "html" || ext === "xml") {
    // 1. Extract HTML comments
    const comments: string[] = [];
    result = result.replace(/&lt;!--[\s\S]*?--&gt;/g, (match) => {
      comments.push(`<span class="hl-comment">${match}</span>`);
      return highlightToken("COMMENT", comments.length - 1);
    });

    // 2. Extract <style> blocks — apply CSS highlighting to content
    const styleBlocks: string[] = [];
    result = result.replace(
      /(&lt;style(?:(?!&gt;)[\s\S])*?&gt;)([\s\S]*?)(&lt;\/style&gt;)/gi,
      (_m, open, inner, close) => {
        styleBlocks.push(`${highlightHtmlTagStr(open)}${applyCssHighlight(inner)}${highlightHtmlTagStr(close)}`);
        return highlightToken("STYLEBLK", styleBlocks.length - 1);
      }
    );

    // 3. Extract <script> blocks — apply JS highlighting to content
    const scriptBlocks: string[] = [];
    result = result.replace(
      /(&lt;script(?:(?!&gt;)[\s\S])*?&gt;)([\s\S]*?)(&lt;\/script&gt;)/gi,
      (_m, open, inner, close) => {
        scriptBlocks.push(`${highlightHtmlTagStr(open)}${applyJsHighlight(inner)}${highlightHtmlTagStr(close)}`);
        return highlightToken("SCRIPTBLK", scriptBlocks.length - 1);
      }
    );

    // 4. Highlight remaining HTML tags
    const tags: string[] = [];
    result = result.replace(/(&lt;\/?[a-zA-Z0-9:-]+)([\s\S]*?)(&gt;)/g, (_match, p1, p2, p3) => {
      let attrs = p2;
      attrs = attrs.replace(/([a-zA-Z0-9:-]+)\s*=\s*(".*?"|'.*?'|[^\s>]+)/g, (_m: string, aName: string, aVal: string) => {
        return `<span class="hl-attr">${aName}</span>=<span class="hl-string">${aVal}</span>`;
      });
      tags.push(`<span class="hl-tag">${p1}</span>${attrs}<span class="hl-tag">${p3}</span>`);
      return highlightToken("TAG", tags.length - 1);
    });

    // 5. Restore all
    for (let i = 0; i < tags.length; i++) result = result.replace(highlightToken("TAG", i), tags[i]);
    for (let i = 0; i < comments.length; i++) result = result.replace(highlightToken("COMMENT", i), comments[i]);
    for (let i = 0; i < styleBlocks.length; i++) result = result.replace(highlightToken("STYLEBLK", i), styleBlocks[i]);
    for (let i = 0; i < scriptBlocks.length; i++) result = result.replace(highlightToken("SCRIPTBLK", i), scriptBlocks[i]);
  } else if (ext === "css") {
    // 1. Extract comments
    const comments: string[] = [];
    result = result.replace(/\/\*[\s\S]*?\*\//g, (match) => {
      comments.push(`<span class="hl-comment">${match}</span>`);
      return highlightToken("COMMENT", comments.length - 1);
    });

    // 2. Extract strings
    const strings: string[] = [];
    result = result.replace(/(".*?"|'.*?')/g, (match) => {
      strings.push(`<span class="hl-string">${match}</span>`);
      return highlightToken("STRING", strings.length - 1);
    });

    // 3. Highlight CSS elements
    result = result
      .replace(/([a-zA-Z0-9.#*@:\[\]=_-]+)\s*(\{)/g, '<span class="hl-keyword">$1</span> $2')
      .replace(/([a-zA-Z0-9-]+)\s*:/g, '<span class="hl-attr">$1</span>:')
      .replace(/(#[a-fA-F0-9]{3,8})/g, '<span class="hl-number">$&</span>')
      .replace(/\b(\d+(?:px|em|rem|%|vh|vw|ms|s|deg)?)\b/g, '<span class="hl-number">$&</span>');

    // 4. Restore strings and comments
    for (let i = 0; i < strings.length; i++) {
      result = result.replace(highlightToken("STRING", i), strings[i]);
    }
    for (let i = 0; i < comments.length; i++) {
      result = result.replace(highlightToken("COMMENT", i), comments[i]);
    }
  } else {
    // C-Style / General programming languages
    const comments: string[] = [];
    result = result
      .replace(/\/\*[\s\S]*?\*\//g, (match) => {
        comments.push(`<span class="hl-comment">${match}</span>`);
        return highlightToken("COMMENT", comments.length - 1);
      })
      .replace(/\/\/.*$/gm, (match) => {
        comments.push(`<span class="hl-comment">${match}</span>`);
        return highlightToken("COMMENT", comments.length - 1);
      })
      .replace(/#.*$/gm, (match) => {
        if (match.startsWith("&#")) return match;
        comments.push(`<span class="hl-comment">${match}</span>`);
        return highlightToken("COMMENT", comments.length - 1);
      });
    const strings: string[] = [];
    result = result
      .replace(/"(\\.|[^"\\])*"/g, (match) => {
        strings.push(`<span class="hl-string">${match}</span>`);
        return highlightToken("STRING", strings.length - 1);
      })
      .replace(/'(\\.|[^'\\])*'/g, (match) => {
        strings.push(`<span class="hl-string">${match}</span>`);
        return highlightToken("STRING", strings.length - 1);
      })
      .replace(/`([\s\S]*?)`/g, (match) => {
        strings.push(`<span class="hl-string">${match}</span>`);
        return highlightToken("STRING", strings.length - 1);
      });
    const keywords = /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|class|interface|export|import|from|as|extends|implements|new|this|typeof|instanceof|void|async|await|pub|fn|struct|impl|match|use|mod|mut|ref|static|enum|type|trait|where|def|elif|try|except|finally|raise|with|global|nonlocal|pass|lambda|and|or|not|in|is|yield)\b/g;
    const types = /\b(string|number|boolean|any|unknown|never|object|u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64|str|String|Vec|Option|Result|Self|self|int|float|dict|list|tuple|set|bool|None|True|False)\b/g;
    result = result
      .replace(keywords, '<span class="hl-keyword">$&</span>')
      .replace(types, '<span class="hl-type">$&</span>')
      .replace(/\b(0x[a-fA-F0-9]+|\d+(?:\.\d*)?)\b/g, '<span class="hl-number">$&</span>');
    for (let i = 0; i < strings.length; i++) {
      result = result.replace(highlightToken("STRING", i), strings[i]);
    }
    for (let i = 0; i < comments.length; i++) {
      result = result.replace(highlightToken("COMMENT", i), comments[i]);
    }
  }

  // 3. Restore search matches with high-contrast Highlights
  for (let i = 0; i < searchMatches.length; i++) {
    const isActive = i === activeMatchIndex;
    const cls = isActive ? "hl-search-match active" : "hl-search-match";
    result = result.replace(highlightToken("SEARCH", i), `<mark class="${cls}">${searchMatches[i]}</mark>`);
  }

  return result;
}

function renderInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function renderMarkdownPreview(markdown: string): string {
  const fences: string[] = [];
  const withoutFences = markdown.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = fences.length;
    const langLabel = lang ? `<span>${escapeHtml(lang)}</span>` : "";
    fences.push(`<pre class="md-code-block">${langLabel}<code>${escapeHtml(code).replace(/\n$/, "")}</code></pre>`);
    return `\n@@CODE_BLOCK_${idx}@@\n`;
  });

  const lines = escapeHtml(withoutFences).split("\n");
  const html: string[] = [];
  let listOpen = false;
  let orderedOpen = false;

  const closeLists = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
    if (orderedOpen) {
      html.push("</ol>");
      orderedOpen = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const codeMatch = line.trim().match(/^@@CODE_BLOCK_(\d+)@@$/);
    if (codeMatch) {
      closeLists();
      html.push(fences[Number(codeMatch[1])] || "");
      continue;
    }
    if (!line.trim()) {
      closeLists();
      html.push('<div class="md-spacer"></div>');
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = line.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      if (orderedOpen) {
        html.push("</ol>");
        orderedOpen = false;
      }
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
      continue;
    }
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (listOpen) {
        html.push("</ul>");
        listOpen = false;
      }
      if (!orderedOpen) {
        html.push("<ol>");
        orderedOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      continue;
    }
    const quote = line.match(/^&gt;\s?(.+)$/);
    if (quote) {
      closeLists();
      html.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    closeLists();
    html.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }

  closeLists();
  return html.join("");
}

export const FileViewerDialog: React.FC<FileViewerDialogProps> = ({ filePath, fileName, onClose, baselineContent }) => {
  const isDiffMode = baselineContent !== undefined;
  const fileIcon = getFileIcon(fileName);
  const isMarkdownFile = getFileExtension(fileName) === "md" || getFileExtension(fileName) === "markdown";
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [markdownPreview, setMarkdownPreview] = useState<boolean>(isMarkdownFile);
  
  // Diff-specific state
  const [diffLines, setDiffLines] = useState<DiffLine[] | null>(null);

  // Implicitly always editable
  const [editedContent, setEditedContent] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [success, setSuccess] = useState<string | null>(null);

  // Search & Replace Overlay States
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [showReplace, setShowReplace] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [replaceQuery, setReplaceQuery] = useState<string>("");
  const [activeMatchIndex, setActiveMatchIndex] = useState<number>(0);

  // Unsaved Warning Dialog State
  const [showUnsavedWarning, setShowUnsavedWarning] = useState<boolean>(false);

  // Element Refs for scroll syncing
  const underlayRef = useRef<HTMLPreElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const diffScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      setSuccess(null);
      setMarkdownPreview(isMarkdownFile);
      try {
        const text = await invoke<string>("read_file_content", { filePath });
        if (active) {
          setContent(text);
          setEditedContent(text);
          if (isDiffMode && baselineContent !== undefined) {
            setDiffLines(computeLineDiff(baselineContent, text));
          }
        }
      } catch (err) {
        if (active) {
          setError(String(err) || "Failed to read file. It might be binary or inaccessible.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [filePath, baselineContent, isDiffMode, isMarkdownFile]);

  const handleDiffScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (linesRef.current) {
      linesRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  };

  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget;
    if (underlayRef.current) {
      underlayRef.current.scrollTop = textarea.scrollTop;
      underlayRef.current.scrollLeft = textarea.scrollLeft;
    }
    if (linesRef.current) {
      linesRef.current.scrollTop = textarea.scrollTop;
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await invoke("create_file", { filePath, content: editedContent });
      setContent(editedContent);
      setSuccess("File saved successfully!");
      setTimeout(() => setSuccess(null), 2000);
      return true;
    } catch (err) {
      setError(String(err) || "Failed to save file.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleRequestClose = () => {
    if (editedContent !== content) {
      setShowUnsavedWarning(true);
    } else {
      onClose();
    }
  };

  const handleWarningSaveClose = async () => {
    const successResult = await handleSave();
    if (successResult) {
      setShowUnsavedWarning(false);
      onClose();
    }
  };

  const handleWarningDiscardClose = () => {
    setShowUnsavedWarning(false);
    onClose();
  };

  // Keyboard shortcut listener (Ctrl+S, Ctrl+F, Ctrl+H, Escape)
  useEffect(() => {
    if (isDiffMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        handleSave();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        setShowSearch(true);
        setShowReplace(false);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
        e.preventDefault();
        e.stopPropagation();
        setShowSearch(true);
        setShowReplace(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleRequestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [editedContent, content]);

  // Find all match indices of searchQuery
  const getMatchIndices = (text: string, query: string) => {
    if (!query) return [];
    const indices: number[] = [];
    let idx = text.toLowerCase().indexOf(query.toLowerCase());
    while (idx !== -1) {
      indices.push(idx);
      idx = text.toLowerCase().indexOf(query.toLowerCase(), idx + 1);
    }
    return indices;
  };
  const searchMatches = getMatchIndices(editedContent, searchQuery);

  // Navigate matching indices and scroll them into view
  const handleNextSearch = (prev = false) => {
    if (searchMatches.length === 0) return;
    if (prev) {
      setActiveMatchIndex(idx => (idx - 1 + searchMatches.length) % searchMatches.length);
    } else {
      setActiveMatchIndex(idx => (idx + 1) % searchMatches.length);
    }
  };

  useEffect(() => {
    if (searchMatches.length > 0 && textareaRef.current) {
      let charIdx = -1;
      let matchCount = 0;
      const queryLower = searchQuery.toLowerCase();
      const contentLower = editedContent.toLowerCase();
      
      let idx = contentLower.indexOf(queryLower);
      while (idx !== -1) {
        if (matchCount === activeMatchIndex) {
          charIdx = idx;
          break;
        }
        matchCount++;
        idx = contentLower.indexOf(queryLower, idx + 1);
      }
      
      if (charIdx !== -1) {
        // Don't steal focus from search input when search overlay is open
        if (!showSearch) {
          textareaRef.current.focus();
        }
        textareaRef.current.setSelectionRange(charIdx, charIdx + searchQuery.length);
        
        // Approximate scroll mapping
        const linesBefore = editedContent.slice(0, charIdx).split("\n").length;
        const lineHeight = 20.15; // aligns height
        textareaRef.current.scrollTop = (linesBefore - 5) * lineHeight;
      }
    }
  }, [activeMatchIndex, searchQuery, showSearch]);

  const handleReplace = () => {
    if (searchMatches.length === 0) return;
    const queryLower = searchQuery.toLowerCase();
    const contentLower = editedContent.toLowerCase();
    let charIdx = -1;
    let matchCount = 0;
    
    let idx = contentLower.indexOf(queryLower);
    while (idx !== -1) {
      if (matchCount === activeMatchIndex) {
        charIdx = idx;
        break;
      }
      matchCount++;
      idx = contentLower.indexOf(queryLower, idx + 1);
    }

    if (charIdx !== -1) {
      const newText = editedContent.slice(0, charIdx) + replaceQuery + editedContent.slice(charIdx + searchQuery.length);
      setEditedContent(newText);
      setActiveMatchIndex(0);
    }
  };

  const handleReplaceAll = () => {
    if (!searchQuery) return;
    const regex = new RegExp(searchQuery.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
    const newText = editedContent.replace(regex, replaceQuery);
    setEditedContent(newText);
    setActiveMatchIndex(0);
  };

  if (isDiffMode) {
    return (
      <div className="dialog-overlay" onClick={onClose}>
        <div
          className="stng-dialog file-viewer-dialog file-viewer-dialog-large"
          onClick={e => e.stopPropagation()}
        >
          <div className="stng-header file-viewer-header">
            <div className="stng-header-left">
              <div className="stng-header-icon file-viewer-file-icon file-ext-diff">
                <i className="bx bx-git-compare" />
              </div>
              <div className="file-viewer-title-stack">
                <span className="stng-header-title">{fileName}</span>
                {!loading && !error && diffLines && (
                  <span className="file-viewer-subtitle">
                    <span style={{ color: "var(--ok)" }}>+{diffLines.filter(l => l.type === "added").length}</span>
                    {" "}
                    <span style={{ color: "var(--err)" }}>-{diffLines.filter(l => l.type === "removed").length}</span>
                    {" · "}
                    {diffLines.length} lines
                  </span>
                )}
              </div>
            </div>
            <button className="stng-close" onClick={onClose}>
              <i className="bx bx-x" />
            </button>
          </div>

          <div className="stng-body file-viewer-body">
            {error && (
              <div className="stng-alert err" style={{ margin: "12px 16px" }}>
                <i className="bx bx-error-circle" />
                <span>{error}</span>
              </div>
            )}

            {loading ? (
              <div className="file-viewer-loading">
                <i className="bx bx-loader-alt bx-spin" style={{ fontSize: "24px", color: "var(--accent)" }} />
                <span style={{ fontSize: "12px", color: "var(--text-3)" }}>Loading diff...</span>
              </div>
            ) : diffLines ? (
              <div className="code-editor-viewport diff-full-viewport">
                <div className="diff-scroll" ref={diffScrollRef} onScroll={handleDiffScroll} style={{ flex: 1, overflow: "auto", fontFamily: "var(--font-mono)", fontSize: "13px", lineHeight: "1.55", padding: "8px 0" }}>
                  {diffLines.length === 0 && (
                    <div className="diff-empty-line">This file is empty, so there are no changed lines to display yet.</div>
                  )}
                  {diffLines.map((line, i) => (
                    <div key={i} className={`diff-line ${line.type}`} style={{ height: "20.15px" }}>
                      <span className="diff-ln diff-ln-old">{line.oldLine ?? ""}</span>
                      <span className="diff-ln diff-ln-new">{line.newLine ?? ""}</span>
                      <span style={{ width: "18px", flexShrink: 0, textAlign: "center", color: line.type === "added" ? "var(--ok)" : line.type === "removed" ? "var(--err)" : "var(--text-3)", fontSize: "12px", userSelect: "none" }}>
                        {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
                      </span>
                      <span style={{ whiteSpace: "pre", color: "var(--text-1)", paddingRight: "16px" }}>{line.text || " "}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const lines = editedContent.split("\n");
  const highlighted = highlightCode(editedContent, fileName, searchQuery, activeMatchIndex);
  const markdownHtml = markdownPreview ? renderMarkdownPreview(editedContent) : "";

  return (
    <div className="dialog-overlay" onClick={handleRequestClose}>
      <div
        className="stng-dialog file-viewer-dialog file-viewer-dialog-large"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="stng-header file-viewer-header">
          <div className="stng-header-left">
            <div className={`stng-header-icon file-viewer-file-icon ${fileIcon.className}`}>
              <i className={`bx ${fileIcon.icon}`} />
            </div>
            <div className="file-viewer-title-stack">
              <span className="stng-header-title">{fileName}</span>
              <span className="file-viewer-subtitle">
                {saving ? (
                  <span style={{ color: "var(--accent)", display: "inline-flex", alignItems: "center" }}>
                    <i className="bx bx-loader-alt bx-spin" style={{ marginRight: "4px" }} />Saving...
                  </span>
                ) : (
                  "(Ctrl+S to save)"
                )}
              </span>
            </div>
          </div>

          <div className="file-viewer-actions">
            {isMarkdownFile && !loading && !error && (
              <button
                type="button"
                className={`stng-btn ${markdownPreview ? "stng-btn-primary" : "stng-btn-ghost"}`}
                onClick={() => setMarkdownPreview(v => !v)}
              >
                <i className={`bx ${markdownPreview ? "bx-edit-alt" : "bxl-markdown"}`} />
                {markdownPreview ? "Edit markdown" : "View as markdown"}
              </button>
            )}
            {/* Restored Text-Only Save Changes button in Header */}
            {!loading && !error && (
              <button
                className="stng-btn"
                onClick={handleSave}
                disabled={saving || editedContent === content}
                data-primary={editedContent !== content}
              >
                Save Changes
              </button>
            )}

            <button className="stng-close" onClick={handleRequestClose}>
              <i className="bx bx-x" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div
          className="stng-body file-viewer-body"
        >
          {error && (
            <div className="stng-alert err" style={{ margin: "12px 16px" }}>
              <i className="bx bx-error-circle" />
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div className="stng-alert ok" style={{ margin: "12px 16px" }}>
              <i className="bx bx-check-circle" />
              <span>{success}</span>
            </div>
          )}

          {loading ? (
            <div
              className="stng-loading file-viewer-loading"
            >
              <i className="bx bx-loader-alt bx-spin" style={{ fontSize: "24px", color: "var(--accent)" }} />
              <span style={{ fontSize: "12px", color: "var(--text-3)" }}>Loading file content...</span>
            </div>
          ) : markdownPreview ? (
            <div className="markdown-preview file-viewer-scroll" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
          ) : (
            <div className="code-editor-viewport" style={{ flex: 1, display: "flex", position: "relative" }}>
              
              {/* Floating Search & Replace Widget */}
              {showSearch && (
                <div className="editor-search-box" onClick={e => e.stopPropagation()}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                      type="text"
                      className="stng-input"
                      value={searchQuery}
                      onChange={e => { setSearchQuery(e.target.value); setActiveMatchIndex(0); }}
                      placeholder="Search..."
                      autoFocus
                      style={{ flex: 1, fontSize: "12px", padding: "4px 8px" }}
                      onKeyDown={e => {
                        if (e.key === "Enter") handleNextSearch(e.shiftKey);
                      }}
                    />
                    <span style={{ fontSize: "11px", color: "var(--text-3)", minWidth: "40px", textAlign: "center" }}>
                      {searchMatches.length > 0 ? `${activeMatchIndex + 1}/${searchMatches.length}` : "0/0"}
                    </span>
                    <button className="stng-btn stng-btn-ghost" onClick={() => handleNextSearch(true)} style={{ padding: "4px", minWidth: "auto" }}>
                      <i className="bx bx-chevron-up" />
                    </button>
                    <button className="stng-btn stng-btn-ghost" onClick={() => handleNextSearch(false)} style={{ padding: "4px", minWidth: "auto" }}>
                      <i className="bx bx-chevron-down" />
                    </button>
                    <button className="stng-btn stng-btn-ghost" onClick={() => { setShowSearch(false); setShowReplace(false); setSearchQuery(""); }} style={{ padding: "4px", minWidth: "auto" }}>
                      <i className="bx bx-x" />
                    </button>
                  </div>
                  {showReplace && (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" }}>
                      <input
                        type="text"
                        className="stng-input"
                        value={replaceQuery}
                        onChange={e => setReplaceQuery(e.target.value)}
                        placeholder="Replace with..."
                        style={{ flex: 1, fontSize: "12px", padding: "4px 8px" }}
                      />
                      <button className="stng-btn stng-btn-ghost" onClick={handleReplace} style={{ fontSize: "11px", padding: "4px 8px" }}>
                        Replace
                      </button>
                      <button className="stng-btn stng-btn-ghost" onClick={handleReplaceAll} style={{ fontSize: "11px", padding: "4px 8px" }}>
                        Replace All
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Line Numbers Container */}
              <div
                ref={linesRef}
                className="editor-line-numbers"
              >
                {lines.map((_, i) => (
                  <span
                    key={i}
                    className="editor-line-number-item"
                  >
                    {i + 1}
                  </span>
                ))}
              </div>

              {/* Transparent Interactive Textarea Overlay */}
              <textarea
                ref={textareaRef}
                className="editor-textarea"
                value={editedContent}
                onChange={e => setEditedContent(e.target.value)}
                onScroll={handleScroll}
                spellCheck={false}
                autoFocus
              />

              {/* Static Highlighted Pre/Code Underlay */}
              <pre
                ref={underlayRef}
                className="editor-underlay-pre"
              >
                <code dangerouslySetInnerHTML={{ __html: highlighted }} />
              </pre>

            </div>
          )}
        </div>
      </div>

      {/* Unsaved Changes Custom Modal Overlay */}
      {showUnsavedWarning && (
        <div
          className="dialog-overlay"
          onClick={() => setShowUnsavedWarning(false)}
          style={{ zIndex: 10000, background: "rgba(0, 0, 0, 0.6)" }}
        >
          <div
            className="dialog-box"
            onClick={e => e.stopPropagation()}
            style={{ width: "360px" }}
          >
            <div className="dialog-header">
              <span className="dialog-title">Unsaved Changes</span>
              <button
                className="dialog-close"
                onClick={() => setShowUnsavedWarning(false)}
              >
                <i className="bx bx-x" />
              </button>
            </div>
            <div className="dialog-body" style={{ padding: "16px", fontSize: "12.5px", color: "var(--text-2)", lineHeight: "1.4" }}>
              You have unsaved changes in <strong>{fileName}</strong>. Do you want to save them before closing?
            </div>
            <div
              className="dialog-footer"
              style={{
                padding: "12px 16px",
                display: "flex",
                gap: "8px",
                justifyContent: "flex-end",
              }}
            >
              <button
                className="stng-btn stng-btn-ghost"
                onClick={() => setShowUnsavedWarning(false)}
                style={{ fontSize: "12px" }}
              >
                Cancel
              </button>
              <button
                className="stng-btn stng-btn-ghost"
                onClick={handleWarningDiscardClose}
                style={{ fontSize: "12px", color: "#f87171" }}
              >
                Don't Save
              </button>
              <button
                className="stng-btn stng-btn-primary"
                onClick={handleWarningSaveClose}
                style={{ fontSize: "12px" }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

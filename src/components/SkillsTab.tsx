import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNotify } from "./Notification";

// ─── Static registry (sourced from skills.sh leaderboard, no API key needed) ──

const STATIC_SKILLS: SkillEntry[] = [
  {id:"vercel-labs/skills/find-skills",slug:"find-skills",name:"Find Skills",source:"vercel-labs/skills",installs:1800000,url:"",description:"Discover and install skills for your AI agent"},
  {id:"anthropics/skills/frontend-design",slug:"frontend-design",name:"Frontend Design",source:"anthropics/skills",installs:478900,url:"",description:"Expert guidance on frontend UI/UX design patterns and best practices"},
  {id:"vercel-labs/agent-skills/vercel-react-best-practices",slug:"vercel-react-best-practices",name:"Vercel React Best Practices",source:"vercel-labs/agent-skills",installs:437900,url:"",description:"React development best practices as recommended by Vercel"},
  {id:"vercel-labs/agent-skills/web-design-guidelines",slug:"web-design-guidelines",name:"Web Design Guidelines",source:"vercel-labs/agent-skills",installs:353600,url:"",description:"Comprehensive web design guidelines and standards"},
  {id:"anthropics/skills/skill-creator",slug:"skill-creator",name:"Skill Creator",source:"anthropics/skills",installs:242000,url:"",description:"Create new skills for AI coding agents"},
  {id:"mattpocock/skills/grill-me",slug:"grill-me",name:"Grill Me",source:"mattpocock/skills",installs:234300,url:"",description:"Ask probing questions to clarify requirements before writing code"},
  {id:"vercel-labs/agent-skills/vercel-composition-patterns",slug:"vercel-composition-patterns",name:"Vercel Composition Patterns",source:"vercel-labs/agent-skills",installs:193000,url:"",description:"Component composition patterns for React and Next.js"},
  {id:"obra/superpowers/brainstorming",slug:"brainstorming",name:"Brainstorming",source:"obra/superpowers",installs:190400,url:"",description:"Structured brainstorming techniques for creative problem solving"},
  {id:"juliusbrussee/caveman/caveman",slug:"caveman",name:"Caveman",source:"juliusbrussee/caveman",installs:190400,url:"",description:"Explain things in the simplest possible way"},
  {id:"mattpocock/skills/improve-codebase-architecture",slug:"improve-codebase-architecture",name:"Improve Codebase Architecture",source:"mattpocock/skills",installs:188900,url:"",description:"Analyse and improve the architecture of an existing codebase"},
  {id:"shadcn/ui/shadcn",slug:"shadcn",name:"shadcn/ui",source:"shadcn/ui",installs:166400,url:"",description:"Build UI components using shadcn/ui component library"},
  {id:"mattpocock/skills/to-prd",slug:"to-prd",name:"To PRD",source:"mattpocock/skills",installs:161400,url:"",description:"Convert a rough idea into a Product Requirements Document"},
  {id:"mattpocock/skills/to-issues",slug:"to-issues",name:"To Issues",source:"mattpocock/skills",installs:155500,url:"",description:"Break down a task or PRD into trackable GitHub issues"},
  {id:"mattpocock/skills/diagnose",slug:"diagnose",name:"Diagnose",source:"mattpocock/skills",installs:154700,url:"",description:"Diagnose bugs methodically before jumping to solutions"},
  {id:"mattpocock/skills/write-a-skill",slug:"write-a-skill",name:"Write A Skill",source:"mattpocock/skills",installs:150300,url:"",description:"Write a new reusable skill for AI agents"},
  {id:"mattpocock/skills/zoom-out",slug:"zoom-out",name:"Zoom Out",source:"mattpocock/skills",installs:149800,url:"",description:"Step back and look at the bigger picture before making changes"},
  {id:"mattpocock/skills/caveman",slug:"caveman",name:"Caveman",source:"mattpocock/skills",installs:145100,url:"",description:"Explain code concepts in simple, plain language"},
  {id:"mattpocock/skills/triage",slug:"triage",name:"Triage",source:"mattpocock/skills",installs:137800,url:"",description:"Triage issues and prioritise what to fix first"},
  {id:"pbakaus/impeccable/impeccable",slug:"impeccable",name:"Impeccable",source:"pbakaus/impeccable",installs:139000,url:"",description:"Make code and output absolutely impeccable — no shortcuts"},
  {id:"vercel-labs/agent-skills/vercel-react-native-skills",slug:"vercel-react-native-skills",name:"React Native Skills",source:"vercel-labs/agent-skills",installs:129900,url:"",description:"React Native development best practices"},
  {id:"anthropics/skills/pptx",slug:"pptx",name:"PowerPoint (PPTX)",source:"anthropics/skills",installs:126200,url:"",description:"Create and edit PowerPoint presentations"},
  {id:"anthropics/skills/pdf",slug:"pdf",name:"PDF",source:"anthropics/skills",installs:121700,url:"",description:"Read, create and manipulate PDF documents"},
  {id:"coreyhaines31/marketingskills/seo-audit",slug:"seo-audit",name:"SEO Audit",source:"coreyhaines31/marketingskills",installs:123400,url:"",description:"Perform a comprehensive SEO audit of a website"},
  {id:"arvindrk/extract-design-system/extract-design-system",slug:"extract-design-system",name:"Extract Design System",source:"arvindrk/extract-design-system",installs:115800,url:"",description:"Extract a design system from an existing codebase"},
  {id:"juliusbrussee/caveman/caveman-commit",slug:"caveman-commit",name:"Caveman Commit",source:"juliusbrussee/caveman",installs:114700,url:"",description:"Write commit messages in simple, clear language"},
  {id:"coreyhaines31/marketingskills/copywriting",slug:"copywriting",name:"Copywriting",source:"coreyhaines31/marketingskills",installs:113000,url:"",description:"Write compelling marketing copy and content"},
  {id:"anthropics/skills/docx",slug:"docx",name:"Word (DOCX)",source:"anthropics/skills",installs:108200,url:"",description:"Create and edit Word documents with rich formatting"},
  {id:"obra/superpowers/test-driven-development",slug:"test-driven-development",name:"Test Driven Development",source:"obra/superpowers",installs:104700,url:"",description:"Full TDD workflow: red, green, refactor"},
  {id:"obra/superpowers/requesting-code-review",slug:"requesting-code-review",name:"Requesting Code Review",source:"obra/superpowers",installs:106200,url:"",description:"Best practices for requesting meaningful code reviews"},
  {id:"mattpocock/skills/prototype",slug:"prototype",name:"Prototype",source:"mattpocock/skills",installs:110000,url:"",description:"Build a quick proof-of-concept prototype"},
  {id:"mattpocock/skills/handoff",slug:"handoff",name:"Handoff",source:"mattpocock/skills",installs:101800,url:"",description:"Create handoff documentation for another developer"},
  {id:"vercel-labs/next-skills/next-best-practices",slug:"next-best-practices",name:"Next.js Best Practices",source:"vercel-labs/next-skills",installs:96400,url:"",description:"Next.js development best practices and patterns"},
  {id:"anthropics/skills/xlsx",slug:"xlsx",name:"Excel (XLSX)",source:"anthropics/skills",installs:95900,url:"",description:"Create and edit Excel spreadsheets with formulas"},
  {id:"supabase/agent-skills/supabase",slug:"supabase",name:"Supabase",source:"supabase/agent-skills",installs:95600,url:"",description:"Full Supabase platform integration and best practices"},
  {id:"mattpocock/skills/tdd",slug:"tdd",name:"TDD",source:"mattpocock/skills",installs:180100,url:"",description:"Test-driven development workflow — write tests first, then code"},
  {id:"obra/superpowers/systematic-debugging",slug:"systematic-debugging",name:"Systematic Debugging",source:"obra/superpowers",installs:119400,url:"",description:"Methodical approach to finding and fixing bugs"},
  {id:"obra/superpowers/writing-plans",slug:"writing-plans",name:"Writing Plans",source:"obra/superpowers",installs:118600,url:"",description:"Create detailed implementation plans before coding"},
  {id:"obra/superpowers/subagent-driven-development",slug:"subagent-driven-development",name:"Subagent Driven Development",source:"obra/superpowers",installs:90300,url:"",description:"Coordinate multiple AI agents to build complex features"},
  {id:"obra/superpowers/verification-before-completion",slug:"verification-before-completion",name:"Verification Before Completion",source:"obra/superpowers",installs:88500,url:"",description:"Verify all requirements are met before declaring a task done"},
  {id:"supabase/agent-skills/supabase-postgres-best-practices",slug:"supabase-postgres-best-practices",name:"Supabase Postgres",source:"supabase/agent-skills",installs:198300,url:"",description:"PostgreSQL best practices when using Supabase"},
  {id:"anthropics/skills/webapp-testing",slug:"webapp-testing",name:"Webapp Testing",source:"anthropics/skills",installs:83700,url:"",description:"Write and run automated tests for web applications"},
  {id:"pbakaus/impeccable/polish",slug:"polish",name:"Polish",source:"pbakaus/impeccable",installs:85700,url:"",description:"Polish and refine existing work to a high standard"},
  {id:"obra/superpowers/receiving-code-review",slug:"receiving-code-review",name:"Receiving Code Review",source:"obra/superpowers",installs:85000,url:"",description:"How to receive and act on code review feedback"},
  {id:"obra/superpowers/writing-skills",slug:"writing-skills",name:"Writing Skills",source:"obra/superpowers",installs:84300,url:"",description:"Improve technical writing and documentation"},
  {id:"obra/superpowers/dispatching-parallel-agents",slug:"dispatching-parallel-agents",name:"Dispatching Parallel Agents",source:"obra/superpowers",installs:82500,url:"",description:"Run multiple agents in parallel for faster development"},
  {id:"obra/superpowers/using-git-worktrees",slug:"using-git-worktrees",name:"Using Git Worktrees",source:"obra/superpowers",installs:82400,url:"",description:"Use Git worktrees for parallel feature development"},
  {id:"pbakaus/impeccable/critique",slug:"critique",name:"Critique",source:"pbakaus/impeccable",installs:83200,url:"",description:"Provide thorough, honest critique of code or design"},
  {id:"pbakaus/impeccable/audit",slug:"audit",name:"Audit",source:"pbakaus/impeccable",installs:82400,url:"",description:"Audit code or systems for quality and correctness"},
  {id:"obra/superpowers/finishing-a-development-branch",slug:"finishing-a-development-branch",name:"Finishing A Branch",source:"obra/superpowers",installs:80200,url:"",description:"Complete a development branch and prepare for merge"},
  {id:"leonxlnx/taste-skill/design-taste-frontend",slug:"design-taste-frontend",name:"Design Taste Frontend",source:"leonxlnx/taste-skill",installs:90400,url:"",description:"Apply refined design taste to frontend projects"},
  {id:"leonxlnx/taste-skill/high-end-visual-design",slug:"high-end-visual-design",name:"High End Visual Design",source:"leonxlnx/taste-skill",installs:77900,url:"",description:"Create visually stunning, high-end UI designs"},
  {id:"leonxlnx/taste-skill/minimalist-ui",slug:"minimalist-ui",name:"Minimalist UI",source:"leonxlnx/taste-skill",installs:71400,url:"",description:"Design clean, minimalist user interfaces"},
  {id:"emilkowalski/skill/emil-design-eng",slug:"emil-design-eng",name:"Emil Design Eng",source:"emilkowalski/skill",installs:72700,url:"",description:"Design engineering patterns from Emil Kowalski"},
  {id:"xixu-me/skills/github-actions-docs",slug:"github-actions-docs",name:"GitHub Actions Docs",source:"xixu-me/skills",installs:179200,url:"",description:"Write and maintain GitHub Actions workflows"},
  {id:"xixu-me/skills/develop-userscripts",slug:"develop-userscripts",name:"Develop Userscripts",source:"xixu-me/skills",installs:130200,url:"",description:"Develop browser userscripts and extensions"},
  {id:"coreyhaines31/marketingskills/content-strategy",slug:"content-strategy",name:"Content Strategy",source:"coreyhaines31/marketingskills",installs:78600,url:"",description:"Develop a comprehensive content marketing strategy"},
  {id:"browser-use/browser-use/browser-use",slug:"browser-use",name:"Browser Use",source:"browser-use/browser-use",installs:77300,url:"",description:"Control and automate web browsers programmatically"},
  {id:"firebase/agent-skills/firebase-basics",slug:"firebase-basics",name:"Firebase Basics",source:"firebase/agent-skills",installs:68200,url:"",description:"Firebase platform integration fundamentals"},
  {id:"firebase/agent-skills/firebase-auth-basics",slug:"firebase-auth-basics",name:"Firebase Auth",source:"firebase/agent-skills",installs:67600,url:"",description:"Implement authentication with Firebase Auth"},
  {id:"firecrawl/cli/firecrawl",slug:"firecrawl",name:"Firecrawl",source:"firecrawl/cli",installs:63700,url:"",description:"Scrape and crawl websites with Firecrawl"},
  {id:"anthropics/skills/mcp-builder",slug:"mcp-builder",name:"MCP Builder",source:"anthropics/skills",installs:65200,url:"",description:"Build Model Context Protocol servers and tools"},
  {id:"anthropics/skills/canvas-design",slug:"canvas-design",name:"Canvas Design",source:"anthropics/skills",installs:64200,url:"",description:"Design visual layouts and canvas-based graphics"},
  {id:"scrapegraphai/just-scrape/just-scrape",slug:"just-scrape",name:"Just Scrape",source:"scrapegraphai/just-scrape",installs:91700,url:"",description:"Scrape web content intelligently"},
  {id:"remotion-dev/skills/remotion-best-practices",slug:"remotion-best-practices",name:"Remotion Best Practices",source:"remotion-dev/skills",installs:338100,url:"",description:"Best practices for creating videos with Remotion"},
  {id:"juliusbrussee/caveman/caveman-review",slug:"caveman-review",name:"Caveman Review",source:"juliusbrussee/caveman",installs:113500,url:"",description:"Review code in simple, direct language"},
  {id:"juliusbrussee/caveman/caveman-compress",slug:"caveman-compress",name:"Caveman Compress",source:"juliusbrussee/caveman",installs:111900,url:"",description:"Compress and simplify complex explanations"},
  {id:"pbakaus/impeccable/overdrive",slug:"overdrive",name:"Overdrive",source:"pbakaus/impeccable",installs:63200,url:"",description:"Go into overdrive mode for maximum output quality"},
  {id:"pbakaus/impeccable/typeset",slug:"typeset",name:"Typeset",source:"pbakaus/impeccable",installs:65100,url:"",description:"Format and typeset documents beautifully"},
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface SkillEntry {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  url: string;
  installUrl?: string;
  isDuplicate?: boolean;
  description?: string;
}

interface InstalledSkill {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  description: string;
  triggers: string[];
  skill_md: string;
  installed_at: number;
}

type FilterMode = "all" | "installed" | "not-installed";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatInstalls(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function parseSkillMdDescription(md: string): string {
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return "";
  const fm = fmMatch[1];
  const descLine = fm.split("\n").find(l => l.startsWith("description:"));
  if (descLine) return descLine.replace(/^description:\s*/, "").replace(/^['"]|['"]$/g, "").trim();
  return "";
}

// ─── SkillCard ────────────────────────────────────────────────────────────────

const SkillCard: React.FC<{
  skill: SkillEntry;
  installed: boolean;
  onInstall: (skill: SkillEntry) => void;
  onUninstall: (skillId: string) => void;
  installedData?: InstalledSkill;
  installing: boolean;
}> = ({ skill, installed, onInstall, onUninstall, installedData, installing }) => {
  const [expanded, setExpanded] = useState(false);
  const [description, setDescription] = useState<string | null>(null);
  const [loadingDesc, setLoadingDesc] = useState(false);

  const handleExpand = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && description === null) {
      // 1. Use description from the static registry (already in skill.description)
      if (skill.description) {
        setDescription(skill.description);
        return;
      }
      // 2. Use description from installed skill data (from SKILL.md frontmatter)
      if (installedData?.description) {
        setDescription(installedData.description);
        return;
      }
      // 3. Fallback: fetch SKILL.md from GitHub raw and parse frontmatter
      setLoadingDesc(true);
      try {
        const parts = skill.id.split("/");
        if (parts.length === 3) {
          const [owner, repo, slug] = parts;
          // Try skills/{slug}/SKILL.md (main branch, then master), then root SKILL.md
          const urlsToTry = [
            `https://raw.githubusercontent.com/${owner}/${repo}/main/skills/${slug}/SKILL.md`,
            `https://raw.githubusercontent.com/${owner}/${repo}/master/skills/${slug}/SKILL.md`,
            `https://raw.githubusercontent.com/${owner}/${repo}/main/SKILL.md`,
            `https://raw.githubusercontent.com/${owner}/${repo}/master/SKILL.md`,
          ];
          let found = false;
          for (const rawUrl of urlsToTry) {
            try {
              const res = await invoke<string>("curl_get", { url: rawUrl });
              if (res && !res.includes("404") && !res.startsWith("{") && res.includes("---")) {
                const desc = parseSkillMdDescription(res);
                setDescription(desc || "No description available.");
                found = true;
                break;
              }
            } catch { /* try next URL */ }
          }
          if (!found) setDescription("No description available.");
        } else {
          setDescription("No description available.");
        }
      } catch {
        setDescription("Could not load description.");
      } finally {
        setLoadingDesc(false);
      }
    }
  };


  return (
    <div className={`skill-card ${installed ? "skill-card-installed" : ""}`}>
      <div className="skill-card-main">
        <div className="skill-card-info">
          <div className="skill-card-header">
            <span className="skill-card-name">{skill.name}</span>
            {installed && <span className="skill-badge-installed"><i className="bx bx-check" /> Installed</span>}
          </div>
          <div className="skill-card-meta">
            <span className="skill-card-source">{skill.source}</span>
            <span className="skill-card-installs"><i className="bx bx-download" /> {formatInstalls(skill.installs)}</span>
          </div>
        </div>

        <div className="skill-card-actions">
          <button
            type="button"
            className="skill-expand-btn"
            onClick={handleExpand}
            title={expanded ? "Collapse" : "Show description"}
          >
            <i className={`bx ${expanded ? "bx-chevron-up" : "bx-chevron-down"}`} />
          </button>

          {installed ? (
            <button
              type="button"
              className="stng-btn stng-btn-danger stng-btn-sm"
              onClick={() => onUninstall(skill.id)}
              title="Uninstall skill"
            >
              <i className="bx bx-trash" />
            </button>
          ) : (
            <button
              type="button"
              className="stng-btn stng-btn-ghost stng-btn-sm skill-install-btn"
              onClick={() => onInstall(skill)}
              disabled={installing}
            >
              {installing ? <i className="bx bx-loader-alt bx-spin" /> : <><i className="bx bx-download" /> Install</>}
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="skill-card-description">
          {loadingDesc ? (
            <span className="skill-desc-loading"><i className="bx bx-loader-alt bx-spin" /> Loading…</span>
          ) : (
            <p>{description || "No description available."}</p>
          )}
        </div>
      )}
    </div>
  );
};

// ─── SkillsTab ────────────────────────────────────────────────────────────────

export const SkillsTab: React.FC = () => {
  const { notifySuccess, notifyError } = useNotify();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [filterMode, setFilterMode] = useState<FilterMode>("all");

  // Remote skills from skills.sh (for "all" and "not-installed" views)
  const [remoteSkills, setRemoteSkills] = useState<SkillEntry[]>([]);
  // Start as true so first render shows spinner, not "No skills found."
  const [loadingRemote, setLoadingRemote] = useState(true);
  const [remotePage, setRemotePage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  // Installed skills from disk
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const [loadingInstalled, setLoadingInstalled] = useState(true);

  // Per-skill install loading state
  const [installing, setInstalling] = useState<Record<string, boolean>>({});

  const installedIds = new Set(installedSkills.map(s => s.id));

  // ── Load installed skills ─────────────────────────────────────────────────
  const loadInstalled = useCallback(async () => {
    setLoadingInstalled(true);
    try {
      const result = await invoke<InstalledSkill[]>("skills_list_installed");
      setInstalledSkills(result);
    } catch {
      // ignore
    } finally {
      setLoadingInstalled(false);
    }
  }, []);

  useEffect(() => { loadInstalled(); }, [loadInstalled]);

  // ── Debounce search query ─────────────────────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 380);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  // ── Fetch remote skills ───────────────────────────────────────────────────
  const fetchRemote = useCallback(async (q: string, page: number, append: boolean) => {
    if (filterMode === "installed") { setLoadingRemote(false); return; }
    setLoadingRemote(true);
    setRemoteError(null);
    try {
      const normalizedQuery = q.trim().toLowerCase();
      const PAGE_SIZE = 50;

      // Show static registry immediately while fetching from skills.sh
      let base: SkillEntry[];
      if (normalizedQuery.length >= 2) {
        base = STATIC_SKILLS.filter(s =>
          s.name.toLowerCase().includes(normalizedQuery) ||
          s.slug.toLowerCase().includes(normalizedQuery) ||
          s.source.toLowerCase().includes(normalizedQuery) ||
          (s.description || "").toLowerCase().includes(normalizedQuery)
        );
      } else {
        const start = page * PAGE_SIZE;
        base = STATIC_SKILLS.slice(start, start + PAGE_SIZE);
      }
      // Show static results immediately (no flicker)
      setRemoteSkills(prev => append ? [...prev, ...base] : base);

      // Try to fetch live data from skills.sh (may take a few seconds)
      try {
        const res = await invoke<string>("skills_fetch_list", { query: normalizedQuery, page });
        const data = JSON.parse(res);
        const liveItems: SkillEntry[] = (data.data || []).map((item: any) => ({
          id: item.id,
          slug: item.slug,
          name: item.name || item.slug,
          source: item.source,
          installs: typeof item.installs === "number" ? item.installs : 0,
          url: "",
          description: item.description || "",
        }));

        if (liveItems.length > 0) {
          // Merge: prefer live data, supplement with static for any not covered
          const liveIds = new Set(liveItems.map(s => s.id));
          const staticOnly = base.filter(s => !liveIds.has(s.id));

          // Supplement missing descriptions from static registry
          const merged = liveItems.map(live => {
            if (!live.description) {
              const staticMatch = STATIC_SKILLS.find(s => s.id === live.id);
              if (staticMatch?.description) return { ...live, description: staticMatch.description };
            }
            return live;
          });

          setRemoteSkills(prev => append ? [...prev, ...merged, ...staticOnly] : [...merged, ...staticOnly]);
          setHasMore(data.pagination?.hasMore ?? false);
        } else {
          setHasMore(!normalizedQuery && (page + 1) * PAGE_SIZE < STATIC_SKILLS.length);
        }
      } catch {
        // skills.sh unavailable — stick with static registry results
        setHasMore(!normalizedQuery && (page + 1) * PAGE_SIZE < STATIC_SKILLS.length);
      }
    } catch (e: any) {
      setRemoteError(`Could not load skills: ${e?.message || e}`);
    } finally {
      setLoadingRemote(false);
    }
  }, [filterMode]);

  // Reset and re-fetch when query or filter changes
  useEffect(() => {
    setRemotePage(0);
    setRemoteSkills([]);
    setHasMore(true);
    fetchRemote(debouncedQuery, 0, false);
  }, [debouncedQuery, filterMode, fetchRemote]);

  const loadMore = () => {
    const nextPage = remotePage + 1;
    setRemotePage(nextPage);
    fetchRemote(debouncedQuery, nextPage, true);
  };

  // ── Install / Uninstall ───────────────────────────────────────────────────
  const handleInstall = async (skill: SkillEntry) => {
    setInstalling(prev => ({ ...prev, [skill.id]: true }));
    try {
      const result = await invoke<InstalledSkill>("skill_install", {
        skillId: skill.id,
        skillName: skill.name,
        source: skill.source,
        installs: skill.installs,
      });
      setInstalledSkills(prev => [result, ...prev]);
      window.dispatchEvent(new CustomEvent("__integradedSkillsUpdated"));
      notifySuccess(`Successfully installed "${skill.name}"`);
    } catch (e: any) {
      notifyError(`Failed to install "${skill.name}": ${e}`);
    } finally {
      setInstalling(prev => ({ ...prev, [skill.id]: false }));
    }
  };

  const handleUninstall = async (skillId: string) => {
    try {
      await invoke("skill_uninstall", { skillId });
      setInstalledSkills(prev => prev.filter(s => s.id !== skillId));
      window.dispatchEvent(new CustomEvent("__integradedSkillsUpdated"));
      notifySuccess("Successfully uninstalled skill.");
    } catch (e: any) {
      notifyError(`Failed to uninstall: ${e}`);
    }
  };

  // ── Derive displayed list ─────────────────────────────────────────────────
  const displayedSkills: SkillEntry[] = (() => {
    if (filterMode === "installed") {
      // Filter installed by query
      const q = query.trim().toLowerCase();
      return installedSkills
        .filter(s => !q || s.name.toLowerCase().includes(q) || s.source.toLowerCase().includes(q))
        .map(s => ({ id: s.id, slug: s.slug, name: s.name, source: s.source, installs: s.installs, url: "" }));
    }
    if (filterMode === "not-installed") {
      return remoteSkills.filter(s => !installedIds.has(s.id));
    }
    return remoteSkills; // all
  })();

  const isLoading = filterMode === "installed" ? loadingInstalled : loadingRemote;

  return (
    <div className="skills-tab">
      {/* ── Search + filter bar ── */}
      <div className="skills-toolbar">
        <div className="skills-search-wrap">
          <i className="bx bx-search skills-search-icon" />
          <input
            type="text"
            className="stng-input skills-search-input"
            placeholder="Search skills…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button className="skills-search-clear" onClick={() => setQuery("")}>
              <i className="bx bx-x" />
            </button>
          )}
        </div>

        <div className="skills-filter-tabs">
          {(["all", "installed", "not-installed"] as FilterMode[]).map(mode => (
            <button
              key={mode}
              type="button"
              className={`skills-filter-tab ${filterMode === mode ? "active" : ""}`}
              onClick={() => setFilterMode(mode)}
            >
              {mode === "all" ? "All" : mode === "installed"
                ? `Installed${installedSkills.length > 0 ? ` (${installedSkills.length})` : ""}`
                : "Not Installed"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Error banner ── */}
      {remoteError && (
        <div className="stng-alert err skills-error">
          <i className="bx bx-error-circle" /><span>{remoteError}</span>
        </div>
      )}

      {/* ── Skill list ── */}
      <div className="skills-list">
        {isLoading && displayedSkills.length === 0 ? (
          <div className="skills-loading">
            <i className="bx bx-loader-alt bx-spin" />
            <span>Loading skills…</span>
          </div>
        ) : displayedSkills.length === 0 ? (
          <div className="skills-empty">
            <i className="bx bx-package" />
            <span>{filterMode === "installed" ? "No skills installed yet." : "No skills found."}</span>
          </div>
        ) : (
          displayedSkills.map(skill => (
            <SkillCard
              key={skill.id}
              skill={skill}
              installed={installedIds.has(skill.id)}
              onInstall={handleInstall}
              onUninstall={handleUninstall}
              installedData={installedSkills.find(s => s.id === skill.id)}
              installing={!!installing[skill.id]}
            />
          ))
        )}

        {/* Load more (only in non-installed views with remote data) */}
        {filterMode !== "installed" && hasMore && !loadingRemote && displayedSkills.length > 0 && !query && (
          <button type="button" className="skills-load-more" onClick={loadMore}>
            Load more skills
          </button>
        )}
        {loadingRemote && displayedSkills.length > 0 && (
          <div className="skills-loading-more">
            <i className="bx bx-loader-alt bx-spin" /> Loading…
          </div>
        )}
      </div>

      <div className="skills-footer">
        Skills powered by <a href="https://skills.sh" target="_blank" rel="noopener noreferrer">skills.sh</a>
      </div>
    </div>
  );
};

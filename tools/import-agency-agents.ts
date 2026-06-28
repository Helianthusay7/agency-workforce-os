import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localizeTemplateName } from "../templateLocalization.js";
const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), "..");
const stateFile = path.join(repoDir, "data", "state.json");
const defaultSource = path.join(repoDir, "vendor", "agency-agents");
const sourceDir = path.resolve(process.argv[2] || defaultSource);
const nonDivisionDirs = new Set([".git", ".github", "examples", "integrations", "scripts", "strategy"]);
function slugify(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}
function parseFrontmatter(raw) {
    if (!raw.startsWith("---"))
        return { metadata: {}, body: raw.trim() };
    const end = raw.indexOf("\n---", 3);
    if (end === -1)
        return { metadata: {}, body: raw.trim() };
    const frontmatter = raw.slice(3, end).trim();
    const body = raw.slice(end + 4).trim();
    const metadata: Record<string, string> = {};
    for (const line of frontmatter.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!match)
            continue;
        metadata[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
    }
    return { metadata, body };
}
function extractSectionItems(body, headingPattern, limit = 6) {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex((line) => headingPattern.test(line));
    if (start === -1)
        return [];
    const items = [];
    for (const line of lines.slice(start + 1)) {
        if (/^#{2,}\s+/.test(line))
            break;
        const match = line.match(/^\s*[-*]\s+\*\*?([^:*]+)\*\*?:?\s*(.*)$/) || line.match(/^\s*[-*]\s+(.+)$/);
        if (!match)
            continue;
        const value = `${match[1]} ${match[2] || ""}`.replace(/\s+/g, " ").trim();
        if (value)
            items.push(value.slice(0, 140));
        if (items.length >= limit)
            break;
    }
    return items;
}
function fallbackDeliverables(body) {
    const items = extractSectionItems(body, /deliverables|outputs|responsibilities|mission/i, 5);
    return items.length ? items : ["结构化执行结果"];
}
async function listMarkdownFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!nonDivisionDirs.has(entry.name))
                files.push(...await listMarkdownFiles(fullPath));
            continue;
        }
        if (entry.isFile() && entry.name.endsWith(".md"))
            files.push(fullPath);
    }
    return files;
}
function divisionFor(filePath) {
    return path.relative(sourceDir, filePath).split(path.sep)[0];
}
async function buildTemplate(filePath) {
    const raw = await readFile(filePath, "utf8");
    const { metadata, body } = parseFrontmatter(raw);
    if (!metadata.name || !metadata.description)
        return null;
    const division = divisionFor(filePath);
    const sourceSlug = path.basename(filePath, ".md");
    return {
        id: `tpl_agency_${slugify(sourceSlug)}`,
        source: "agency-agents",
        sourcePath: path.relative(sourceDir, filePath).replaceAll(path.sep, "/"),
        name: localizeTemplateName(metadata.name),
        sourceName: metadata.name,
        division,
        summary: metadata.description,
        deliverables: fallbackDeliverables(body),
        defaultTools: ["knowledge", "artifact-write"],
        systemPrompt: body,
        metadata: {
            color: metadata.color || "",
            emoji: metadata.emoji || "",
            vibe: metadata.vibe || ""
        }
    };
}
async function main() {
    if (!existsSync(sourceDir)) {
        throw new Error(`agency-agents source directory not found: ${sourceDir}`);
    }
    if (!existsSync(stateFile)) {
        throw new Error(`state.json not found: ${stateFile}`);
    }
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (!Array.isArray(state.agentTemplates))
        state.agentTemplates = [];
    const files = await listMarkdownFiles(sourceDir);
    const templates = (await Promise.all(files.map(buildTemplate))).filter((template) => Boolean(template));
    const byId = new Map(state.agentTemplates.map((template) => [template.id, template]));
    let added = 0;
    let updated = 0;
    for (const template of templates) {
        if (byId.has(template.id)) {
            Object.assign(byId.get(template.id), template);
            updated += 1;
        }
        else {
            state.agentTemplates.push(template);
            byId.set(template.id, template);
            added += 1;
        }
    }
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ sourceDir, scanned: files.length, imported: templates.length, added, updated }, null, 2));
}
main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});

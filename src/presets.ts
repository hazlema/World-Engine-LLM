export interface Preset {
  slug: string;
  title: string;
  description: string;
  objects: string[];
  objectives: string[];
  body: string;
}

export function presetSlugFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

const REQUIRED_STRING_FIELDS = ["title", "description"] as const;
const REQUIRED_LIST_FIELDS = ["objects", "objectives"] as const;

export function parsePresetText(text: string, slug: string): Preset {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`Preset ${slug}: missing frontmatter delimiters`);
  }
  const [, frontmatter, rawBody] = match;
  const fields = parseFrontmatter(frontmatter, slug);
  const body = rawBody.trim();

  for (const f of REQUIRED_STRING_FIELDS) {
    const v = fields.strings[f];
    if (!v) throw new Error(`Preset ${slug}: required field "${f}" is missing or empty`);
  }
  for (const f of REQUIRED_LIST_FIELDS) {
    const v = fields.lists[f];
    if (!v || v.length === 0) {
      throw new Error(`Preset ${slug}: required list "${f}" is missing or empty`);
    }
  }
  if (!body) throw new Error(`Preset ${slug}: body is empty`);

  return {
    slug,
    title: fields.strings.title!,
    description: fields.strings.description!,
    objects: fields.lists.objects!,
    objectives: fields.lists.objectives!,
    body,
  };
}

function parseFrontmatter(
  text: string,
  slug: string
): { strings: Record<string, string>; lists: Record<string, string[]> } {
  const strings: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const lines = text.split(/\r?\n/);

  let currentList: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") {
      currentList = null;
      continue;
    }
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentList) {
      lists[currentList].push(listItem[1].trim());
      continue;
    }
    const keyValue = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (keyValue) {
      const [, key, rest] = keyValue;
      const value = rest.trim();
      if (value === "") {
        // List header (or empty scalar — caller's required-field check catches the latter).
        lists[key] = [];
        currentList = key;
      } else {
        strings[key] = value;
        currentList = null;
      }
      continue;
    }
    throw new Error(`Preset ${slug}: malformed frontmatter line: ${line}`);
  }
  return { strings, lists };
}

export async function loadAllPresets(dir = "presets"): Promise<Map<string, Preset>> {
  const out = new Map<string, Preset>();
  const glob = new Bun.Glob(`${dir}/*.md`);
  for await (const path of glob.scan(".")) {
    const slug = presetSlugFromPath(path);
    const text = await Bun.file(path).text();
    out.set(slug, parsePresetText(text, slug));
  }
  return out;
}

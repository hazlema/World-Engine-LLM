import type { Position } from "./stack";

export interface PlayerAttribute {
  name: string;
  scope: string[];   // sub-bullets in order; empty when no sub-bullets
}

export interface PresetObjective {
  text: string;
  position?: Position;
}

export interface Preset {
  slug: string;
  title: string;
  description: string;
  objects: string[];
  objectives: PresetObjective[];
  attributes: PlayerAttribute[];   // empty array when no attributes: header
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

  const objectives: PresetObjective[] = fields.lists.objectives!.map(parseObjectiveLine);

  return {
    slug,
    title: fields.strings.title!,
    description: fields.strings.description!,
    objects: fields.lists.objects!,
    objectives,
    attributes: fields.attributes,
    body,
  };
}

function parseObjectiveLine(raw: string): PresetObjective {
  const m = raw.match(/^(.*?)\s*@\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
  if (!m || m[1].length === 0) return { text: raw };
  return { text: m[1], position: [Number(m[2]), Number(m[3])] };
}

function parseFrontmatter(
  text: string,
  slug: string
): { strings: Record<string, string>; lists: Record<string, string[]>; attributes: PlayerAttribute[] } {
  const strings: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const attributes: PlayerAttribute[] = [];
  const lines = text.split(/\r?\n/);

  let currentList: string | null = null;
  let inAttributesMode = false;
  let currentAttribute: PlayerAttribute | null = null;

  for (const line of lines) {
    if (line.trim() === "") {
      currentList = null;
      inAttributesMode = false;
      currentAttribute = null;
      continue;
    }

    // Sub-bullet (4-space indent). Valid only inside attributes mode under a top-level bullet.
    const subItem = line.match(/^    -\s+(.*)$/);
    if (subItem) {
      if (!inAttributesMode || !currentAttribute) {
        throw new Error(`Preset ${slug}: sub-bullet not allowed here: ${line}`);
      }
      const subText = subItem[1].trim();
      if (!subText) throw new Error(`Preset ${slug}: empty sub-bullet at line: ${line}`);
      currentAttribute.scope.push(subText);
      if (currentAttribute.scope.length > 10) {
        throw new Error(
          `Preset ${slug}: more than 10 sub-bullets under attribute "${currentAttribute.name}"`
        );
      }
      continue;
    }

    // Top-level bullet (2-space indent).
    const listItem = line.match(/^  -\s+(.*)$/);
    if (listItem && currentList) {
      const itemText = listItem[1].trim();
      if (!itemText) throw new Error(`Preset ${slug}: empty bullet at line: ${line}`);
      if (inAttributesMode) {
        if (itemText.length > 80) {
          throw new Error(`Preset ${slug}: attribute name exceeds 80 chars: ${line}`);
        }
        currentAttribute = { name: itemText, scope: [] };
        attributes.push(currentAttribute);
      } else {
        lists[currentList].push(itemText);
      }
      continue;
    }

    // Key-value (scalar or list header).
    const keyValue = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (keyValue) {
      const [, key, rest] = keyValue;
      const value = rest.trim();
      if (value === "") {
        // List header.
        if (key === "attributes") {
          inAttributesMode = true;
          currentList = key;          // bookkeeping; attributes go into the separate array
          currentAttribute = null;
        } else {
          inAttributesMode = false;
          lists[key] = [];
          currentList = key;
          currentAttribute = null;
        }
      } else {
        strings[key] = value;
        currentList = null;
        inAttributesMode = false;
        currentAttribute = null;
      }
      continue;
    }

    throw new Error(`Preset ${slug}: malformed frontmatter line: ${line}`);
  }

  return { strings, lists, attributes };
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

export interface SlashCommand {
  name: string;
  args: string;
}

export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1).trim();
  if (body.length === 0) return null;
  const spaceIdx = body.indexOf(" ");
  if (spaceIdx === -1) return { name: body.toLowerCase(), args: "" };
  return {
    name: body.slice(0, spaceIdx).toLowerCase(),
    args: body.slice(spaceIdx + 1).trim(),
  };
}

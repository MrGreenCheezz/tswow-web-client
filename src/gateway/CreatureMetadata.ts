import { readFile } from "node:fs/promises";

export interface CreatureMetadata {
  entry: number;
  name: string;
  subname: string;
  type: number;
  family: number;
  rank: number;
}

export async function loadCreatureMetadata(path: string): Promise<Map<number, CreatureMetadata>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value) || value.length > 200_000) throw new Error("Creature metadata file is invalid");
  const result = new Map<number, CreatureMetadata>();
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 6
      || !row.every((field, index) => index === 1 || index === 2 ? typeof field === "string" : typeof field === "number" && Number.isFinite(field))) {
      throw new Error("Creature metadata row is invalid");
    }
    const [entry, name, subname, type, family, rank] = row as [number, string, string, number, number, number];
    result.set(entry, { entry, name, subname, type, family, rank });
  }
  return result;
}

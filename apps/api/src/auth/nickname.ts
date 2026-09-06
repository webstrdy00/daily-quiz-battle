import { randomInt } from "node:crypto";

const adjectives = ["차분한", "느긋한", "다정한", "명랑한"] as const;
const animals = ["토끼", "수달", "참새", "고양이"] as const;

export function generateNickname(): string {
  const adjective = adjectives[randomInt(adjectives.length)]!;
  const animal = animals[randomInt(animals.length)]!;
  return `${adjective}${animal}${randomInt(1000, 10000)}`;
}

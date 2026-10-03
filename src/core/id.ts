// Node / role handle 生成：前缀 + 短随机串。创建时一次性生成，之后不可变。
// 注意：核心层不能用 Math.random 直接埋进确定性逻辑，但创建 Node/role 是真实副作用动作，
// 这里接受一个随机源参数,默认用平台随机。插件/CLI 传入各自的实现。

export type RandomSource = () => number;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // 去掉易混字符 i l o u

/** User-visible Node handle prefix. */
export const NODE_ID_PREFIX = "node-";
/** Role 稳定身份前缀（合同冻结）。 */
export const ROLE_ID_PREFIX = "role-";
/** Immutable Context Card identity prefix. */
export const CARD_ID_PREFIX = "card-";

function makePrefixedId(prefix: string, rand: RandomSource = Math.random, len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return prefix + s;
}

function makeUniquePrefixedId(
  prefix: string,
  existing: Set<string>,
  rand: RandomSource = Math.random,
): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = makePrefixedId(prefix, rand);
    if (!existing.has(id)) return id;
  }
  const id = makePrefixedId(prefix, rand, 10);
  if (existing.has(id)) throw new Error(`Cannot allocate a unique ${prefix} identity.`);
  return id;
}

export function makeNodeId(rand: RandomSource = Math.random, len = 6): string {
  return makePrefixedId(NODE_ID_PREFIX, rand, len);
}

export function makeCardId(rand: RandomSource = Math.random, len = 8): string {
  return makePrefixedId(CARD_ID_PREFIX, rand, len);
}

/** 确保不撞已有 id。 */
export function makeUniqueNodeId(existing: Set<string>, rand: RandomSource = Math.random): string {
  return makeUniquePrefixedId(NODE_ID_PREFIX, existing, rand);
}

/** 确保不撞已有 role id。 */
export function makeUniqueRoleId(existing: Set<string>, rand: RandomSource = Math.random): string {
  return makeUniquePrefixedId(ROLE_ID_PREFIX, existing, rand);
}

export function isNodeId(id: string): boolean {
  return /^node-[a-z0-9]+$/i.test(id);
}

export function isRoleId(id: string): boolean {
  return /^role-[a-z0-9]+$/i.test(id);
}

export function isCardId(id: string): boolean {
  return /^card-[a-z0-9]+$/i.test(id);
}

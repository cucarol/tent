/** A Card queues by publication time; keys compare by code unit, independently of host locale. */
export function cardOrderKey(id: string, publishedAt: string): string {
  return `${new Date(publishedAt).toISOString()}|${id}`;
}

/** Render an instant for people without changing its stored or JSON representation. */
export function formatCliTime(value: string): string {
  const date = new Date(value);
  const pad = (number: number, width = 2) => String(number).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const absoluteOffset = Math.abs(offset);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)} ` +
    `${offset < 0 ? "-" : "+"}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`
  );
}

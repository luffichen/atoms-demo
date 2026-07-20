import { formatLocalTime } from "../lib";

export function LocalTime({ value }: { value: string }) {
  const time = formatLocalTime(value);
  return (
    <time dateTime={value} title={time.full}>
      {time.short}
    </time>
  );
}

export const pool = { size: 4 };

// TODO: make the pool size configurable
export function connect() {
  return pool;
}

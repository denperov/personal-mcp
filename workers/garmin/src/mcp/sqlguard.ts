// The guard is the first layer; the second (mandatory) one is a transaction that always rolls back:
// one exec runs every statement in the string, so getting past the guard leaves nothing behind.

// Literals and comments left to right, as in the SQLite tokenizer ('' inside reads as two adjacent literals, same result)
const SKIP = /'[^']*'|"[^"]*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g;
const UNCLOSED = /['"`[]|\/\*/;
const FORBIDDEN = new RegExp(String.raw`\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE` +
  String.raw`|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|RETURNING)\b|\bREPLACE\b(?!\s*\()`, "i");

const no = (reason: string) => ({ ok: false as const, reason });

/** The returned sql has no trailing ";" */
export function checkReadOnlySql(sql: string): { ok: true; sql: string } | { ok: false; reason: string } {
  if (sql.includes("\0")) return no("NUL characters are not allowed");
  // literals and comments → spaces of the same length: positions match the original string
  let code = sql.replace(SKIP, (m) => " ".repeat(m.length));
  if (UNCLOSED.test(code)) return no("unterminated string, identifier or comment");
  const end = code.trimEnd().length - 1;
  if (code[end] === ";") {
    sql = sql.slice(0, end) + sql.slice(end + 1);
    code = code.slice(0, end);
  }
  if (code.includes(";")) return no("only one statement is allowed");
  if (!/^\s*(SELECT|WITH|VALUES)\b/i.test(code)) return no("only SELECT, WITH or VALUES queries are allowed");
  const bad = FORBIDDEN.exec(code);
  return bad ? no(`forbidden keyword: ${bad[0].toUpperCase()}`) : { ok: true, sql };
}

const ROLLBACK = new Error("rollback"); // private rollback marker

export function readOnlyQuery(storage: DurableObjectStorage, sql: string, limit: number, maxChars: number):
  { columns: string[]; rows: unknown[][]; rowsRead: number; truncated: boolean } {
  let out: ReturnType<typeof readOnlyQuery> | undefined;
  try {
    storage.transactionSync(() => {
      // limit + 1: the extra row signals that the result is truncated
      const c = storage.sql.exec(`SELECT * FROM (\n${sql}\n) LIMIT ?`, limit + 1);
      const rows: unknown[][] = [];
      let chars = 1, truncated = false; // chars == JSON.stringify(rows).length
      for (const r of c.raw()) {
        chars += JSON.stringify(r).length + 1;
        if (rows.length === limit || chars > maxChars) {
          truncated = true;
          break;
        }
        rows.push(r);
      }
      out = { columns: c.columnNames, rows, rowsRead: c.rowsRead, truncated };
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out!;
}

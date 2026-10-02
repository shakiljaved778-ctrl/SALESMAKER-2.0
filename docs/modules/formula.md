# Formula

Spec: §5.5 · Code: `packages/formula` (`@sm/formula`) · Used by: validation rules (RecordService), the Setup
formula check, list and report filters compiled to SQL

One expression language for the whole product (golden rule: one engine per concern). It parses, type-checks,
evaluates in TypeScript, and compiles to Postgres with the same semantics.

## Pipeline

| Step       | Module                       | What it does                                                                                                                                                                     |
| ---------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lex, parse | `lexer.ts`, `parser.ts`      | Salesforce-style syntax; `==`/`<>` accepted as `=`/`!=`; `/* … */` comments; quoted text with escapes. ≤ 5,000 characters, ≤ 100 nesting levels. Errors carry spans.             |
| Check      | `check.ts`, `environment.ts` | Resolves fields (snake_case API names, case-insensitive) and relationships (`account_id` → `account`, `partner__c` → `partner__r`, ≤ 5 hops) through metadata; types every node. |
| Evaluate   | `evaluate.ts`                | Decimals with 34 significant digits, half away from zero; "treat blanks as blanks"; short-circuit `IF`/`AND`/`OR`; runtime errors as codes with spans.                           |
| Compile    | `sql.ts`                     | `compileToSql()` to a Postgres expression with the evaluator's semantics; refuses what cannot run in a query as `not_filterable`.                                                |

## Types and rules

Types: Number, Currency, Percent, Text, Boolean, Date, DateTime, Time, Picklist, MultiPicklist. Picklists are
compared only through `ISPICKVAL`, `TEXT`, `ISBLANK` and `CASE`; Currency survives `+ - * /` with plain numbers and
Currency ÷ Currency is a Number. `CASE` needs an else value. `TODAY()` uses the user's time zone, else the
organisation's. `ADDMONTHS` keeps month-end dates at month end. `REGEX` matches the whole text and is limited to
10,000 characters. `DATEDIFF(start, end)` counts whole days; `BUSINESSDAYS` counts Monday–Friday until business
hours exist (P03). Validation rules may use `ISCHANGED`, `PRIORVALUE` and `ISNEW`.

## SQL compilation

Proven equal to the evaluator over shared rows for 120 hand-written formulas and 300 random well-typed ones (to 12
decimal places). `ISCHANGED`/`PRIORVALUE`/`ISNEW`, `REGEX`, `VALUE`, `INCLUDES`, `BUSINESSDAYS`, `ADDMONTHS` on
date-times and fields of other objects are `not_filterable`. Where the evaluator raises a runtime error (division
by zero) the SQL yields NULL and the row does not match.

## Errors in the UI

Errors are `{ code, params, span }`; the Setup rule editor translates `setup.rules.errors.<code>` and shows the
position. `POST /v1/setup/objects/{object}/formula/check` type-checks as you type without saving.

## Tests

`packages/formula/test`: parser (with a 3,000-input fuzz that only ever yields syntax errors), checker, evaluator,
and `sql.test.ts`, which runs every formula through Postgres and the evaluator and compares. Coverage gate ≥ 90%.

// FILE: 051_AutomationBaseBranch.ts
// Purpose: Adds the optional pinned base branch standalone automation runs fetch+branch from.
// Layer: Server persistence migration
// Depends on: automation_definitions and schemaHelpers.columnExists.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "automation_definitions", "base_branch"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN base_branch TEXT
    `;
  }
});

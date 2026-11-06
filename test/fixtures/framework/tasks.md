# Tasks: Orders pagination

## Traceability matrix

| AC | Tasks | Verification |
|----|-------|--------------|
| AC-1 | T-2, T-3 | npm test -- orders |
| AC-2 | T-2, T-3 | npm test -- orders |
| AC-3 | T-4 | npm run openapi:check |

## Task table

| ID | Task | Owner role | Files / areas | Depends on | ACs | Verification |
|----|------|------------|---------------|------------|-----|--------------|
| T-1 | Add orders service skeleton | backend | src/server/services/orders.ts | - | AC-1 | npm run build |
| T-2 | Write failing tests for pagination and validation | test | test/orders.test.ts | T-1 | AC-1, AC-2 | npm test -- orders |
| T-3 | Implement GET /api/orders with pagination | backend | src/server/routes/orders.ts, src/server/services/orders.ts | T-1, T-2 | AC-1, AC-2 | npm test -- orders |
| T-4 | Document endpoint in OpenAPI | docs | docs/openapi.yaml | T-3 | AC-3 | npm run openapi:check |

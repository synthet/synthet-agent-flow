# Orders pagination

## Acceptance criteria

- **AC-1**: WHEN a client calls GET /api/orders THEN the API returns orders sorted by created_at, 20 per page.
- **AC-2**: WHEN page or limit is invalid THEN the API returns 400 with a validation message.
- AC-3: The OpenAPI document lists the new endpoint.

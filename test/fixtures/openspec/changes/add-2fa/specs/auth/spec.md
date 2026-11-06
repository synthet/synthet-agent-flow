## ADDED Requirements

### Requirement: Two-factor login
Users with 2FA enabled MUST provide a valid TOTP code.

#### Scenario: Valid code
- **WHEN** a user submits a correct code
- **THEN** the login succeeds

#### Scenario: Invalid code
- **WHEN** a user submits a wrong code
- **THEN** the login is rejected with 401

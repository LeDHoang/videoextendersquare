# Beta Launch Checklist

Last updated: 2026-09-11

## Required before launch

- [ ] Generate a long random value and set `SX_SECURITY_SECRET`.
- [ ] Set `SX_ADMIN_USERS` and/or `SX_MODERATOR_USERS` to the launch-team usernames or emails.
- [ ] Set `SX_PUBLIC_URL` to the deployed website URL.
- [ ] Set `SX_COOKIE_SECURE=1` when serving over HTTPS.
- [ ] Keep `SX_PASSWORD_RESET_EXPOSE_TOKEN=0` outside local development.
- [ ] Keep `SX_TRUST_PROXY_HEADERS=0` unless a trusted reverse proxy overwrites `X-Forwarded-For`.
- [ ] Configure `SX_SMTP_HOST`, `SX_SMTP_PORT`, `SX_SMTP_FROM`, credentials, and TLS settings.
- [ ] Send a real password-reset email and verify the deployed reset link.
- [ ] Back up the production database.
- [ ] Run `make migrate` before starting the updated backend.
- [ ] Run `make build` and deploy the generated frontend.
- [ ] Run `make test` in the normal project `.venv`.
- [ ] Smoke-test registration, login, profile editing, post editing/deletion, Saved links, blocking, reporting, moderation, password reset, and account deletion.
- [ ] Validate the reels/profile experience on a physical Quest device. Automated Quest verification is still outstanding because `metavr` is unsupported on the current Linux host.

## Existing pre-Alembic database only

Do not use this procedure for a blank database.

- [ ] Confirm the old social tables exist and `alembic_version` does not.
- [ ] Back up `data/echo.db`.
- [ ] Run `.venv/bin/python -m alembic stamp 20260910_0001`.
- [ ] Run `make migrate`.

## Suggested production environment

```env
SX_SECURITY_SECRET=<long-random-secret>
SX_ADMIN_USERS=<admin-username-or-email>
SX_MODERATOR_USERS=
SX_PUBLIC_URL=https://your-domain.example
SX_COOKIE_SECURE=1
SX_TRUST_PROXY_HEADERS=0
SX_PASSWORD_RESET_EXPOSE_TOKEN=0

SX_SMTP_HOST=
SX_SMTP_PORT=465
SX_SMTP_USERNAME=
SX_SMTP_PASSWORD=
SX_SMTP_FROM=
SX_SMTP_SSL=1
SX_SMTP_STARTTLS=1
```

## Completed implementation

- [x] Saved-post navigation fix.
- [x] Post edit/delete controls and ownership checks.
- [x] Explicit Alembic migrations and startup schema revision validation.
- [x] Blocking and blocked-content filtering.
- [x] User, post, and comment reporting.
- [x] Moderator report queue and moderation actions.
- [x] Password reset and account deletion.
- [x] Database-backed authentication throttling and trusted-proxy opt-in.
- [x] Avatar upload dimension protection.
- [x] Backend profile/safety integration tests.
- [x] Frontend Saved-link regression tests.
- [x] Production frontend build and syntax validation.

## Latest automated verification

Run on 2026-09-11:

- Backend profile/safety tests: 4 passed.
- Frontend regression tests: 2 passed.
- React production build: passed.
- Python compilation: passed.
- Inline reels JavaScript parse check: passed.
- Alembic upgrade and schema drift check: passed.
- Git whitespace validation: passed.

The unscoped repository-wide `pytest` command also collects the separate, user-owned `ComfyUI/` tree and hardware-specific tests with unavailable dependencies. Use `make test` for this website's beta profile/safety suite.

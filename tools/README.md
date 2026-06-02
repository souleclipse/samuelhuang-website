# Tools

Python scripts for deterministic execution. Each script should do one thing well.

## Conventions
- Load credentials from `.env` using `python-dotenv`
- Accept inputs via CLI args or stdin
- Write outputs to `.tmp/` or directly to cloud services
- Exit with code 0 on success, non-zero on failure

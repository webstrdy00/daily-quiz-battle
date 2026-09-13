"""Verify the generated Netlify artifacts without reading or printing secrets."""
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parent.parent
output = root / "apps/api/.netlify/functions"
manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
functions = {function["name"]: function for function in manifest["functions"]}
if set(functions) != {"api", "operations"}:
    raise SystemExit("Unexpected function set")
expected_routes = {"/v1/*", "/health/*", "/internal/metrics"}
if {route.get("pattern", route.get("literal")) for route in functions["api"]["routes"]} != expected_routes:
    raise SystemExit("Unexpected API routes")
if functions["operations"].get("schedule") != "@daily":
    raise SystemExit("Unexpected operations schedule")
ca_path = "apps/api/ssl/supabase-prod-ca-2021.crt"
expected_ca = (root / ca_path).read_bytes()
for name, function in functions.items():
    if function.get("runtimeVersion") != "nodejs24.x":
        raise SystemExit("Unexpected Node runtime")
    with ZipFile(output / (name + ".zip")) as archive:
        if archive.namelist().count(ca_path) != 1:
            raise SystemExit("Missing or duplicate CA certificate")
        if hashlib.sha256(archive.read(ca_path)).digest() != hashlib.sha256(expected_ca).digest():
            raise SystemExit("Bundled CA differs from source")
        for member in archive.namelist():
            parts = Path(member).parts
            if any(part in {"secrets", ".secrets", "certs"} for part in parts):
                raise SystemExit("Private directory included in function bundle")
            if any(part == ".env" or part.startswith(".env.") for part in parts):
                raise SystemExit("Environment file included in function bundle")
            if member.endswith((".key", ".p12", ".pfx")):
                raise SystemExit("Private key container included in function bundle")
    print(name + ": routes/runtime/CA/private-file checks passed")

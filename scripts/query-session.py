#!/usr/bin/env python3
"""Query the most recent agent session and list all its requests."""
import json
import subprocess
import sys

# Fetch the most recent session
result = subprocess.run(
    ["curl", "-s", "http://localhost:7777/agent-sessions?limit=1", "-H", "x-project: default"],
    capture_output=True, text=True
)

data = json.loads(result.stdout)
# Could be list or { sessions: [...] }
sessions = data if isinstance(data, list) else data.get("sessions", [])
if not sessions:
    print("No sessions found")
    sys.exit(1)

session = sessions[0]
sid = session["_id"]
title = session.get("title", "?")
print(f"Session: {sid}")
print(f"Title: {title[:80]}")
print(f"Created: {session.get('createdAt', '?')}")
print()

# Fetch full session with stats
result2 = subprocess.run(
    ["curl", "-s", f"http://localhost:7777/agent-sessions/{sid}", "-H", "x-project: default"],
    capture_output=True, text=True
)

full = json.loads(result2.stdout)
st = full.get("stats", {})
if st:
    print(f"Total Requests: {st.get('requestCount', 0)}")
    print(f"Models: {st.get('models', [])}")
    print(f"Input Tokens: {st.get('totalInputTokens', 0):,}")
    print(f"Output Tokens: {st.get('totalOutputTokens', 0):,}")
    print(f"Total Tokens: {st.get('totalTokens', 0):,}")
    print(f"Total Cost: ${st.get('totalCost', 0):.5f}")
    
    orch = st.get("orchestrator", {})
    work = st.get("workers", {})
    if orch:
        print(f"\nOrchestrator: {orch.get('requestCount', 0)} requests, out={orch.get('totalOutputTokens',0):,}")
    if work:
        print(f"Workers: {work.get('requestCount', 0)} requests, out={work.get('totalOutputTokens',0):,}")
    print()

# Query requests directly from MongoDB via admin stats endpoint
# Try the requests listing endpoint
result3 = subprocess.run(
    ["curl", "-s", f"http://localhost:7777/admin/stats/requests?agentSessionId={sid}&limit=100", "-H", "x-project: default"],
    capture_output=True, text=True
)

try:
    req_data = json.loads(result3.stdout)
except:
    # Try alternate endpoint
    result3 = subprocess.run(
        ["curl", "-s", f"http://localhost:7777/admin/requests?agentSessionId={sid}&limit=100", "-H", "x-project: default"],
        capture_output=True, text=True
    )
    try:
        req_data = json.loads(result3.stdout)
    except:
        print(f"Could not query requests. Response: {result3.stdout[:300]}")
        sys.exit(1)

requests_list = req_data if isinstance(req_data, list) else req_data.get("requests", req_data.get("data", []))

if not requests_list:
    print(f"No requests found via admin route.")
    print(f"Response preview: {json.dumps(req_data)[:300]}")
else:
    print(f"{'='*100}")
    print(f"  All {len(requests_list)} requests for session")
    print(f"{'='*100}")
    for i, r in enumerate(requests_list):
        op = r.get("operation", r.get("endpoint", "?"))
        model = (r.get("model", "?") or "?")[:30]
        inp = r.get("inputTokens", 0) or 0
        out = r.get("outputTokens", 0) or 0
        ts = r.get("timestamp", "?")
        asid = r.get("agentSessionId", "?")
        is_worker = asid != sid
        marker = " [WORKER]" if is_worker else ""
        print(f"  {i+1:2d}. {op:25s} | {model:30s} | in:{inp:>8,} out:{out:>8,}{marker}  {ts}")

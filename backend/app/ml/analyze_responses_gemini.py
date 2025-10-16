#!/usr/bin/env python3
import os
import re
import glob
import json
import sys
from dotenv import load_dotenv
import google.generativeai as genai
import argparse

# --- Load environment variables from .env ---
load_dotenv()
api_key = os.getenv("GEMINI_API_KEY")

if not api_key:
    print("⚠️  GEMINI_API_KEY not set. Please add it to your .env file.")
    client = None
else:
    try:
        genai.configure(api_key=api_key)
        client = genai.GenerativeModel("gemini-2.5-flash")
        print("✅ Gemini connected successfully.")
    except Exception as e:
        print(f"❌ Gemini initialization failed: {e}")
        client = None

# --- Keywords for local triage ---
TRIAGE_KEYWORDS = [
    "500 Internal Server Error", "SQL syntax", "ORA-", "exception",
    "root:x:0", "<script>", "onerror=", "could not resolve host"
]

# --- Helper functions ---
def get_status_code(html_path):
    """Extract HTTP status from first line of .html"""
    try:
        with open(html_path, 'r', encoding='utf-8', errors='ignore') as f:
            line = f.readline().strip()
            match = re.search(r'HTTP/\d\.\d\s+(\d{3})', line)
            return match.group(1) if match else None
    except Exception:
        return None
def get_latest_responses_dir(base_path):
    """Find the most recent 'responses_*' directory."""
    pattern = os.path.join(base_path, "responses_*")
    dirs = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    return dirs[0] if dirs else None

def get_payload_and_url(meta_path):
    """Extract payload and URL from .meta file"""
    try:
        with open(meta_path, 'r', encoding='utf-8', errors='ignore') as f:
            text = f.read()
            url_match = re.search(r'https?://[^\s"]+', text)
            payload_match = re.search(r'-d\s+[\'"](.*?)[\'"]', text)
            return (
                payload_match.group(1).strip() if payload_match else None,
                url_match.group(0) if url_match else "N/A"
            )
    except Exception:
        return None, None

def extract_text_from_response(response):
    """Robust extraction of text from Gemini SDK response"""
    candidates = []
    text = getattr(response, "text", None)
    if text: candidates.append(text)
    try:
        cand = response.candidates[0].content.parts[0].text
        if cand: candidates.append(cand)
    except Exception: pass
    try:
        cand = response.candidates[0].text
        if cand: candidates.append(cand)
    except Exception: pass
    candidates.append(str(response))
    for c in candidates:
        s = c.strip()
        if s: return s
    return ""

def find_json_in_text(s):
    """Extract JSON substring if model adds extra commentary"""
    start = s.find("{")
    end = s.rfind("}")
    if start != -1 and end != -1 and end > start:
        return s[start:end+1]
    return None

def analyze_with_gemini(html, meta, err, payload):
    """Send flagged response to Gemini for AI-based classification"""
    if not client:
        return None, "Skipped (Gemini not configured)"

    prompt = f""" You are an expert security researcher analyzing a fuzzer's output. 
    Your task is to analyze the provided HTTP response data and determine if a vulnerability (like XSS, SQLi, CMDi, Path Traversal, or Auth Bypass) was successfully exploited. 
    - The payload used was: "{payload}" 
    - The server's HTTP status and headers are in the HTML content.
    - Check the HTML body for payload reflection, server stack traces, database error messages, or unexpected command output (e.g., 'root:x:0').
    - Check the cURL Error Log for network errors that suggest a blind CMDi/SSRF attempt (e.g., 'could not resolve host').
    Analyze the following contents: --- RESPONSE METADATA (.meta) --- {meta} --- HTTP RESPONSE (HEADERS + BODY) (.html) --- {html} --- CURL ERROR LOG (.err) --- {err}
    Based on your analysis, provide a result in the following JSON format ONLY: {{ "vulnerability_type": "None" | "XSS" | "SQLi" | "CMDi" | "PathTraversal" | "AuthBypass" | "AppError", "confidence": "High" | "Medium" | "Low" | "None", "reasoning_summary": "Explain why this response indicates a vulnerability (e.g., 'Payload was reflected', 'SQL syntax error found', 'Server crashed')." }} """

    try:
        response = client.generate_content(prompt)
        text = extract_text_from_response(response)
        if not text:
            return None, "Empty response from Gemini"

        # Try parsing JSON directly
        try:
            return json.loads(text), None
        except Exception:
            # Attempt to extract JSON substring
            json_sub = find_json_in_text(text)
            if json_sub:
                try:
                    return json.loads(json_sub), None
                except Exception as e:
                    return None, f"Invalid JSON extracted: {e}. Raw: {text[:400]}"
            return None, f"No JSON found in response. Snippet: {text[:200]}"
    except Exception as e:
        return None, f"Gemini API call failed: {e}"

def analyze_responses(folder):
    """Main loop: triage + optional Gemini analysis"""
    meta_files = sorted(glob.glob(os.path.join(folder, "response*.meta")))
    if not meta_files:
        print(f"No response files found in {folder}")
        return

    print(f"--- Running triage on {len(meta_files)} responses ---")
    for meta_path in meta_files:
        html_path = meta_path.replace(".meta", ".html")
        err_path = meta_path.replace(".meta", ".err")

        if not os.path.exists(html_path):
            continue

        status = get_status_code(html_path)
        payload, url = get_payload_and_url(meta_path)
        html = open(html_path, encoding='utf-8', errors='ignore').read()
        meta = open(meta_path, encoding='utf-8', errors='ignore').read()
        err = open(err_path, encoding='utf-8', errors='ignore').read() if os.path.exists(err_path) else ""

        # Local triage: flag suspicious responses
        if any(k.lower() in html.lower() for k in TRIAGE_KEYWORDS) or (payload and payload in html):
            print(f"[FLAGGED] {os.path.basename(html_path)} (Status: {status})")

            result, error = analyze_with_gemini(html, meta, err, payload or "N/A")
            if error:
                print(f"   ❌ Gemini error: {error}")
            elif result:
                print(f"   ✅ {result['vulnerability_type']} ({result['confidence']}): {result['reasoning_summary']}")
                json_file = html_path.replace(".html", ".gemini.json")
                with open(json_file, "w", encoding="utf-8") as f:
                    json.dump(result, f, indent=4)
                print(f"   💾 Saved Gemini analysis to {json_file}")
        else:
            print(f"[OK] {os.path.basename(html_path)} seems clean.")

# --- Main entry point ---
if __name__ == "__main__":
    

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "dir",
        nargs="?",  # makes it optional
        help="Path to responses directory (optional, defaults to latest responses_ directory)"
    )
    args = parser.parse_args()

    if args.dir:
        response_dir = os.path.abspath(args.dir)
    else:
        base_path = "/home/arunexploit/develop/Smartfuzzier/backend/app/node-crawler/src"
        latest_dir = get_latest_responses_dir(base_path)
        if not latest_dir:
            print(f"❌ ERROR: No 'responses_*' directory found in {base_path}")
            sys.exit(1)
        response_dir = latest_dir
        print(f"⚙️ Using latest responses directory: {response_dir}")

    print(f"📂 Scanning directory: {response_dir}")
    analyze_responses(response_dir)

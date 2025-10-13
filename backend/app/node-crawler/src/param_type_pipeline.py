#!/usr/bin/env python3
"""
param_type_pipeline.py

Usage examples:

# 1) Train model from templates (uses heuristic bootstrap labels):
python param_type_pipeline.py --input param_templates.json --train --model param_type_model.joblib

# 2) Run prediction + active learning and output enriched templates:
python param_type_pipeline.py --input param_templates.json --model param_type_model.joblib --predict --output param_templates_with_predicted_types.json

# 3) Train + predict in one step (train from heuristics, predict, active-learn, retrain, output):
python param_type_pipeline.py --input param_templates.json --train --predict --active --output param_templates_with_predicted_types.json

Notes:
 - Requires scikit-learn, pandas, joblib, numpy
 - pip install scikit-learn pandas joblib numpy
"""

import argparse
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.feature_extraction import DictVectorizer
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, accuracy_score

# ---------- Config ----------
UUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
DEFAULT_MODEL_PATH = "param_type_model.joblib"
DEFAULT_OUTPUT = "param_templates_with_predicted_types.json"
CONFIDENCE_THRESHOLD = 0.70  # below this considered low-confidence for active learning
ACTIVE_BATCH = 20  # max items to request labels for in one active session
RANDOM_STATE = 42


# ---------- Heuristic bootstrap labeler ----------
def heuristic_label(name, value, options=None):
    if options and len(options) > 0:
        return "enum"
    if value is None:
        if name and re.search(r'id$|_id$|^id$|count|num|size|page|limit', name, re.I):
            return "int"
        return "string"
    v = str(value).strip()
    if v == "":
        if name and re.search(r'id$|_id$|^id$|count|num|size|page|limit', name, re.I):
            return "int"
        return "string"
    if v.lower() in ("true", "false"):
        return "bool"
    if v in ("0", "1") and name and re.search(r'^(is|has|enable|flag)|_flag$', name, re.I):
        return "bool"
    if re.fullmatch(r'-?\d+', v):
        return "int"
    if re.fullmatch(r'-?\d+\.\d+', v):
        return "float"
    if UUID_RE.match(v):
        return "uuid"
    if "@" in v and "." in v:
        return "email"
    return "string"


# ---------- Feature extraction ----------
def extract_feature_dict(param_entry, context=None):
    """
    param_entry: dict with keys: name, original_value, options (optional), required (optional)
    context: dict with 'method','template' etc (optional)
    """
    name = (param_entry.get("name") or "") if param_entry else ""
    orig = param_entry.get("original_value", "")
    options = param_entry.get("options") or param_entry.get("opts") or None
    required = bool(param_entry.get("required", False))
    method = (context.get("method") if context else "") or ""

    v = str(orig) if orig is not None else ""

    feats = {}
    # name features
    feats["name_len"] = len(name)
    feats["name_has_id_token"] = int(bool(re.search(r'\b(id|_id|user|uid|uid\b)', name, re.I)))
    feats["name_has_num"] = int(bool(re.search(r'\d', name)))
    feats["name_has_date"] = int(bool(re.search(r'date|day|month|year|dob', name, re.I)))
    feats["name_has_email"] = int(bool(re.search(r'email|e-mail', name, re.I)))
    feats["name_starts_is"] = int(bool(re.match(r'^(is|has|should|enable|can)_?', name, re.I)))

    # value features
    feats["val_len"] = len(v)
    feats["val_is_digits"] = int(v.isdigit())
    feats["val_has_alpha"] = int(bool(re.search(r'[A-Za-z]', v)))
    feats["val_has_special"] = int(bool(re.search(r'[^A-Za-z0-9]', v)))
    feats["val_is_uuid"] = int(bool(UUID_RE.match(v)))
    feats["val_is_bool_token"] = int(v.lower() in ("true", "false"))
    feats["val_is_int"] = int(bool(re.fullmatch(r'-?\d+', v)))
    feats["val_is_float"] = int(bool(re.fullmatch(r'-?\d+\.\d+', v)))
    feats["val_has_at"] = int("@" in v)
    feats["required"] = int(required)
    feats["method_POST"] = int(method.upper() == "POST")
    feats["method_GET"] = int(method.upper() == "GET")
    feats["has_options"] = int(bool(options))
    feats["options_count"] = len(options) if options else 0

    # small text features (prefix / suffix)
    feats["name_prefix_3"] = name[:3].lower() if len(name) >= 3 else name.lower()
    feats["name_suffix_3"] = name[-3:].lower() if len(name) >= 3 else name.lower()

    # keep raw for display
    feats["_raw_name"] = name
    feats["_raw_value"] = v
    feats["_template"] = context.get("template") if context else ""

    return feats


# ---------- Dataset builders ----------
def build_dataset_from_templates(templates):
    rows = []
    meta = []
    for t in templates:
        method = t.get("method") or ""
        for p in t.get("params", []):
            ctx = {"method": method, "template": t.get("template")}
            feat = extract_feature_dict(p, context=ctx)
            label = p.get("type") or heuristic_label(p.get("name"), p.get("original_value"), options=p.get("options"))
            feat["label"] = label
            rows.append(feat)
            meta.append({"template_id": t.get("id"), "param_name": p.get("name")})
    if not rows:
        return pd.DataFrame(), meta
    df = pd.DataFrame(rows)
    return df, meta


# ---------- Train / save / load ----------
def train_model_from_df(df, model_path=DEFAULT_MODEL_PATH):
    y = df["label"].values
    # drop meta columns
    X = df.drop(columns=["label", "_raw_name", "_raw_value", "_template"], errors="ignore")
    # DictVectorizer expects list of dicts
    dv = DictVectorizer(sparse=False)
    X_mat = dv.fit_transform(X.to_dict(orient="records"))
    clf = RandomForestClassifier(n_estimators=200, random_state=RANDOM_STATE, n_jobs=-1)
    X_train, X_test, y_train, y_test = train_test_split(X_mat, y, test_size=0.2, random_state=RANDOM_STATE, stratify=y)
    clf.fit(X_train, y_train)
    y_pred = clf.predict(X_test)
    print("Train accuracy (test split):", accuracy_score(y_test, y_pred))
    print(classification_report(y_test, y_pred, zero_division=0))
    joblib.dump({"dv": dv, "clf": clf}, model_path)
    print("Saved model to", model_path)
    return dv, clf


def load_model(model_path=DEFAULT_MODEL_PATH):
    obj = joblib.load(model_path)
    return obj["dv"], obj["clf"]


# ---------- Prediction helpers ----------
def predict_params_for_templates(templates, dv, clf):
    results = []  # (template_idx, param_idx, name, orig_value, probs, pred)
    rows = []
    mapping = []
    for t_idx, t in enumerate(templates):
        method = t.get("method") or ""
        for p_idx, p in enumerate(t.get("params", [])):
            ctx = {"method": method, "template": t.get("template")}
            feat = extract_feature_dict(p, context=ctx)
            rows.append({k: v for k, v in feat.items() if not k.startswith("_")})  # keep only numeric/categorical features
            mapping.append((t_idx, p_idx, p.get("name"), p.get("original_value")))
    if not rows:
        return []
    X_mat = dv.transform(rows)
    probs = clf.predict_proba(X_mat)
    classes = clf.classes_
    preds = clf.predict(X_mat)
    out = []
    for i, (t_idx, p_idx, name, orig_value) in enumerate(mapping):
        prob_arr = {cls: float(probs[i, j]) for j, cls in enumerate(classes)}
        pred = preds[i]
        confidence = float(prob_arr.get(pred, 0.0))
        out.append({
            "template_index": t_idx,
            "param_index": p_idx,
            "name": name,
            "original_value": orig_value,
            "predicted": pred,
            "confidence": confidence,
            "probabilities": prob_arr
        })
    return out


# ---------- Active learning (terminal) ----------
def run_active_learning(templates, dv, clf, threshold=CONFIDENCE_THRESHOLD, batch=ACTIVE_BATCH):
    preds = predict_params_for_templates(templates, dv, clf)
    low = [p for p in preds if p["confidence"] < threshold]
    # sort by ascending confidence
    low_sorted = sorted(low, key=lambda x: x["confidence"])
    if not low_sorted:
        print("No low-confidence items (threshold {}).".format(threshold))
        return []

    # limit batch
    to_label = low_sorted[:batch]
    manual_labels = []
    print(f"\nActive learning: please label up to {len(to_label)} items (low-confidence). Type label or ENTER to skip.\n")
    print("Allowed labels: int, float, bool, uuid, email, enum, string\n")
    for i, item in enumerate(to_label, 1):
        t = templates[item["template_index"]]
        p = t["params"][item["param_index"]]
        print(f"Item {i}/{len(to_label)} | template_id={t.get('id')} | param='{item['name']}' | original_value='{item['original_value']}' | predicted={item['predicted']} ({item['confidence']:.2f})")
        print("Context URL:", t.get("template"))
        user = input("Enter label (or press ENTER to skip): ").strip()
        if not user:
            print("Skipped.\n")
            continue
        if user not in ("int", "float", "bool", "uuid", "email", "enum", "string"):
            print("Invalid label; skipped.\n")
            continue
        # store manual label
        manual_labels.append({
            "template_index": item["template_index"],
            "param_index": item["param_index"],
            "label": user
        })
        print("Labeled as", user, "\n")
    return manual_labels


# ---------- Retrain with manual labels ----------
def retrain_with_manual_labels(templates, manual_labels, dv_and_clf_path=None):
    # Apply labels into a temp dataset and retrain
    # Build dataset with current heuristic labels, then override with manual labels where provided.
    templates_copy = json.loads(json.dumps(templates))  # deep copy
    for ml in manual_labels:
        t_idx = ml["template_index"]
        p_idx = ml["param_index"]
        label = ml["label"]
        try:
            templates_copy[t_idx]["params"][p_idx]["type"] = label
        except Exception:
            continue
    df, _ = build_dataset_from_templates(templates_copy)
    if df.empty:
        print("No data for retraining.")
        return None, None
    dv, clf = train_model_from_df(df, model_path=(dv_and_clf_path or DEFAULT_MODEL_PATH))
    return dv, clf


# ---------- Baseline benign value generator ----------
BASELINE_MAP = {
    "int": "1",
    "float": "1.23",
    "bool": "true",
    "uuid": "00000000-0000-0000-0000-000000000000",
    "email": "test@example.com",
    "enum": lambda opts: (opts[0] if isinstance(opts, list) and len(opts) > 0 else "option1"),
    "string": "test"
}

def produce_benign_value_for_param(param_entry, predicted_type):
    opts = param_entry.get("options") or param_entry.get("opts") or None
    if predicted_type == "enum":
        return BASELINE_MAP["enum"](opts)
    return BASELINE_MAP.get(predicted_type, "test")


# ---------- Utilities for I/O and orchestration ----------
def _normalize_param(p):
    """
    Convert a param object from incoming formats into the internal param representation:
    { name, original_value, options, required, type (if present) }
    """
    if p is None:
        return {"name": "", "original_value": "", "options": None, "required": False}
    # prefer explicit keys if present
    name = p.get("name") or p.get("key") or p.get("param") or ""
    # Many sources put default/value/original_value/type differently; try common candidates
    orig = p.get("original_value")
    if orig is None:
        orig = p.get("value")
    if orig is None:
        orig = p.get("default")
    if orig is None:
        # sometimes `type` is present but no value — we'll leave blank
        orig = p.get("example") or ""
    options = p.get("options") or p.get("opts") or p.get("choices") or None
    required = bool(p.get("required", False))
    # keep any provided explicit 'type' field from input (we still use heuristic if missing)
    explicit_type = p.get("type")
    out = {
        "name": name,
        "original_value": orig,
        "options": options,
        "required": required
    }
    if explicit_type:
        out["type"] = explicit_type
    return out


def load_templates(path):
    """
    Load many possible JSON shapes and normalize into a list of templates:
    Each template will be a dict with keys:
      - id (prefer url/action or generated index)
      - template (URL)
      - method (HTTP method)
      - params: list of param objects (name, original_value, options, required, maybe type)
    Supported incoming shapes:
      - top-level list of template objects (old format)
      - {"templates": [...]} where templates is list
      - object with "forms" and/or "endpoints" arrays (new format you showed)
      - other dicts: attempt to find 'forms' or 'endpoints' keys
    """
    with open(path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)

    # Already in expected form: list of templates
    if isinstance(raw, list):
        return raw

    # If wrapper { "templates": [...] }
    if isinstance(raw, dict) and "templates" in raw and isinstance(raw["templates"], list):
        return raw["templates"]

    normalized = []
    # If JSON contains forms/endpoints (your example)
    if isinstance(raw, dict):
        seqs = []
        if "forms" in raw and isinstance(raw["forms"], list):
            seqs.append(("forms", raw["forms"]))
        if "endpoints" in raw and isinstance(raw["endpoints"], list):
            seqs.append(("endpoints", raw["endpoints"]))
        # Also accept 'pages', 'requests' etc if present (generic fallback)
        if not seqs:
            # try to detect any list-of-objects under top-level keys that look like endpoints
            for k, v in raw.items():
                if isinstance(v, list) and v and isinstance(v[0], dict):
                    # heuristically accept if elements have 'url' or 'action' or 'method' keys
                    if any(isinstance(v[0].get(k2), str) for k2 in ("url", "action", "method")):
                        seqs.append((k, v))

        # Build normalized templates list from detected sequences
        idx = 0
        for seq_name, seq in seqs:
            for item in seq:
                # prefer action then url fields for the template location
                template_url = item.get("action") or item.get("url") or item.get("template") or ""
                method = (item.get("method") or "").upper() if item.get("method") else (item.get("verb") or "").upper()
                params_raw = item.get("params") or item.get("parameters") or []
                params = []
                for p in params_raw:
                    params.append(_normalize_param(p))
                t = {
                    "id": template_url or f"{seq_name}_{idx}",
                    "template": template_url,
                    "method": method,
                    "params": params
                }
                normalized.append(t)
                idx += 1

    # If normalization found something return it; otherwise, fallback: if raw is a dict that looks like a single template
    if normalized:
        return normalized

    # last fallback: if raw itself looks like a single template with keys 'params', 'method', 'url' etc.
    if isinstance(raw, dict) and ("params" in raw or "forms" in raw or "endpoints" in raw):
        # If it has 'forms' use those
        if "forms" in raw and isinstance(raw["forms"], list):
            norm = []
            for idx, form in enumerate(raw["forms"]):
                template_url = form.get("action") or form.get("url") or form.get("template") or f"form_{idx}"
                method = (form.get("method") or "").upper()
                params = [_normalize_param(p) for p in (form.get("params") or [])]
                norm.append({"id": template_url, "template": template_url, "method": method, "params": params})
            return norm
        # else if raw has params directly
        if "params" in raw and isinstance(raw["params"], list):
            template_url = raw.get("url") or raw.get("action") or raw.get("template") or "template_0"
            method = (raw.get("method") or "").upper()
            params = [_normalize_param(p) for p in raw.get("params", [])]
            return [{"id": template_url, "template": template_url, "method": method, "params": params}]

    # If nothing matched, raise helpful error
    raise ValueError("Unrecognized input JSON format. Expected list-of-templates or object with 'forms'/'endpoints'.")


def write_output_templates(templates, predictions, out_path, input_format_hint=None):
    """
    Merge predictions into templates and write JSON.
    predictions is list of dicts from predict_params_for_templates (with template_index and param_index)
    """
    enriched = json.loads(json.dumps(templates))  # deep copy
    # Map predictions by template_index,param_index
    for p in predictions:
        t_idx = p["template_index"]
        p_idx = p["param_index"]
        pred = p["predicted"]
        conf = p["confidence"]
        try:
            param_obj = enriched[t_idx]["params"][p_idx]
            param_obj["predicted_type"] = pred
            param_obj["predicted_confidence"] = conf
            param_obj["baseline_value"] = produce_benign_value_for_param(param_obj, pred)
        except Exception:
            continue
    # add metadata
    meta = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "model": DEFAULT_MODEL_PATH,
    }
    if input_format_hint:
        meta["input_format"] = input_format_hint
    out = {"meta": meta, "templates": enriched}
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    print("Wrote enriched templates to", out_path)


# ---------- CLI main ----------
def main():
    ap = argparse.ArgumentParser(description="Param type ML pipeline: train, predict, active learning.")
    ap.add_argument("--input", "-i", required=True, help="Input param_templates.json")
    ap.add_argument("--model", "-m", default=DEFAULT_MODEL_PATH, help="Model path (joblib)")
    ap.add_argument("--train", action="store_true", help="Train model (from heuristic labels)")
    ap.add_argument("--predict", action="store_true", help="Predict and produce output JSON")
    ap.add_argument("--active", action="store_true", help="Run active learning loop to label low-confidence items")
    ap.add_argument("--output", "-o", default=DEFAULT_OUTPUT, help="Output enriched templates JSON")
    args = ap.parse_args()

    templates_path = Path(args.input)
    if not templates_path.exists():
        print("Input file not found:", templates_path)
        return

    # Try to load and normalize templates from multiple possible JSON shapes
    try:
        templates = load_templates(str(templates_path))
    except Exception as e:
        print("Error loading templates:", e)
        return

    # templates should now be a list of normalized template dicts
    if not isinstance(templates, list):
        print("Expected normalized templates to be a list. Got:", type(templates))
        return

    input_format_hint = "list"  # optional hint we add to output meta
    # best-effort: check original raw to set hint (not strictly necessary)
    try:
        raw = json.load(open(str(templates_path), "r", encoding="utf-8"))
        if isinstance(raw, dict):
            if "forms" in raw or "endpoints" in raw:
                input_format_hint = "forms/endpoints"
            elif "templates" in raw:
                input_format_hint = "templates-wrapper"
            else:
                input_format_hint = "object"
        elif isinstance(raw, list):
            input_format_hint = "list"
    except Exception:
        pass

    if args.train:
        df, _ = build_dataset_from_templates(templates)
        if df.empty:
            print("No training data found in templates.")
        else:
            dv, clf = train_model_from_df(df, model_path=args.model)
    else:
        # Try load existing model for predict/active
        if not Path(args.model).exists():
            print("Model file not found. Run --train first or provide a valid --model.")
            return
        dv, clf = load_model(args.model)

    if args.predict:
        preds = predict_params_for_templates(templates, dv, clf)
        # Optionally run active learning
        manual_labels = []
        if args.active:
            manual_labels = run_active_learning(templates, dv, clf, threshold=CONFIDENCE_THRESHOLD, batch=ACTIVE_BATCH)
            if manual_labels:
                # retrain with manual labels
                dv, clf = retrain_with_manual_labels(templates, manual_labels, dv_and_clf_path=args.model)

                # re-predict after retraining
                preds = predict_params_for_templates(templates, dv, clf)
        write_output_templates(templates, preds, args.output, input_format_hint=input_format_hint)
    print("Done.")


if __name__ == "__main__":
    main()

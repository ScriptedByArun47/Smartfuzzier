# SmartFuzzer

SmartFuzzer is a tool for discovering API endpoints and parameters in a target domain, inferring parameter types using heuristics and machine learning, and generating payloads for testing input handling, including SQL injection.  
> ⚠️ For authorized security testing only. Use only on systems you own or have permission to test.

---

## Features

- Normalize crawler/scanner outputs (`forms` / `endpoints`) into unified templates.
- Heuristic labeling to bootstrap parameter types: `string`, `int`, `bool`, `uuid`, `email`, `enum`, `float`.
- Trainable ML pipeline (RandomForest) to predict parameter types from names, values, and context.
- Active learning loop: label low-confidence predictions interactively.
- Baseline payload generator for safe testing.
- JSON input/output for integration with fuzzers and scanners.

---

## Quick Start

### Requirements

```bash
pip install scikit-learn pandas joblib numpy
```

##Train model
```bash
python param_type_pipeline.py --input param_templates.json --train --model param_type_model.joblib
```
## run 
```bash
node server.js 
```
## frontend 
open with live server index.html

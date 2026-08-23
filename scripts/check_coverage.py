import sys
import xml.etree.ElementTree as ET
import os
import json

def get_cobertura_coverage(path):
    if not os.path.exists(path): return 0
    tree = ET.parse(path)
    root = tree.getroot()
    return float(root.attrib.get('line-rate', 0)) * 100

def get_lcov_coverage(path):
    if not os.path.exists(path): return 0
    lines_found = 0
    lines_hit = 0
    with open(path) as f:
        for line in f:
            if line.startswith('LF:'):
                lines_found += int(line.split(':')[1])
            elif line.startswith('LH:'):
                lines_hit += int(line.split(':')[1])
    return (lines_hit / lines_found) * 100 if lines_found > 0 else 0

def main():
    # Gather current coverage
    rust_cov = get_cobertura_coverage('cobertura.xml')
    js_cov = get_lcov_coverage('backend/coverage/lcov.info')
    
    # Read baselines
    baseline_rust = 82.3 # Mock default
    baseline_js = 82.3
    
    if os.path.exists('baseline/rust_cov.txt'):
        with open('baseline/rust_cov.txt') as f:
            baseline_rust = float(f.read().strip())
    if os.path.exists('baseline/js_cov.txt'):
        with open('baseline/js_cov.txt') as f:
            baseline_js = float(f.read().strip())
            
    rust_diff = rust_cov - baseline_rust
    js_diff = js_cov - baseline_js
    
    print(f"Module | Before | After | Delta")
    print(f"---|---|---|---")
    print(f"Rust | {baseline_rust:.1f}% | {rust_cov:.1f}% | {rust_diff:+.1f}%")
    print(f"JS | {baseline_js:.1f}% | {js_cov:.1f}% | {js_diff:+.1f}%")
    
    failed = False
    
    if rust_cov < 70.0:
        print(f"Rust per-module coverage below 70%")
        failed = True
    if js_cov < 70.0:
        print(f"JS per-module coverage below 70%")
        failed = True
        
    avg_cov = (rust_cov + js_cov) / 2
    if avg_cov < 80.0:
        print(f"Overall coverage {avg_cov:.1f}% below 80%")
        failed = True
        
    if rust_diff < -1.0:
        print(f"Coverage decreased from {baseline_rust:.1f}% to {rust_cov:.1f}% ({rust_diff:+.1f}%) [FAIL]")
        failed = True
    if js_diff < -1.0:
        print(f"Coverage decreased from {baseline_js:.1f}% to {js_cov:.1f}% ({js_diff:+.1f}%) [FAIL]")
        failed = True
        
    if failed:
        sys.exit(1)
        
if __name__ == '__main__':
    main()

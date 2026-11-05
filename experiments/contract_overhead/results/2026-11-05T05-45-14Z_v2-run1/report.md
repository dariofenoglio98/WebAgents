# Contract overhead v2: 2026-11-05T05-45-14Z_v2-run1

Median (p95) in milliseconds; every number computed by `aggregate_v2.py` from the raw samples.

- Source: `experiments/contract_overhead/results/2026-11-05T05-45-14Z_v2-run1`

- Commit `8334b4c290c169b9c6e087f3188d7185d51cf647`; benchmark 2.0.0; protocol sha256 `80c15e8959b6…`.

## Groups and total (Tab. 9)

| Runtime | Quantity | meeting-agenda | literature-review | webair | travel-network |
|---|---|---|---|---|---|
| Python reference | Package verification | 20.2 (20.8) |  | 246 (253) | 30.0 (30.9) |
| Python reference | Authorization / binding | 0.78 (0.82) |  | 3.88 (3.99) | 1.39 (1.45) |
| Python reference | Run Plan preparation | 1.20 (1.25) |  | 6.31 (6.46) | 2.24 (2.38) |
| Python reference | Pre-execution revalidation | 37.4 (38.7) |  | 481 (490) | 56.9 (58.8) |
| Python reference | total_pre_execution | 59.6 (61.4) |  | 737 (750) | 90.5 (93.5) |
| Chrome core (Node) | Package verification | 7.07 (9.24) | 54.7 (66.9) | 55.0 (63.4) | 9.89 (12.3) |
| Chrome core (Node) | Authorization / binding | 0.23 (0.27) | 1.67 (2.03) | 2.84 (3.30) | 0.85 (1.29) |
| Chrome core (Node) | Run Plan preparation | 0.38 (0.44) | 3.06 (3.56) | 5.33 (6.02) | 1.59 (1.76) |
| Chrome core (Node) | Pre-execution revalidation | 27.0 (33.6) | 208 (233) | 213 (239) | 37.9 (43.9) |
| Chrome core (Node) | total_pre_execution | 34.7 (41.9) | 269 (299) | 278 (310) | 50.5 (58.4) |

## Stages

| Runtime | Quantity | meeting-agenda | literature-review | webair | travel-network |
|---|---|---|---|---|---|
| Python reference | package_open_verify | 20.2 (20.8) |  | 246 (253) | 30.0 (30.9) |
| Python reference | authorization_receipt | 0.51 (0.54) |  | 0.73 (0.77) | 0.52 (0.55) |
| Python reference | compatibility_evaluation | 0.28 (0.30) |  | 3.15 (3.24) | 0.87 (0.91) |
| Python reference | run_plan_preparation | 1.20 (1.25) |  | 6.31 (6.46) | 2.24 (2.38) |
| Python reference | host_revalidation_lease | 1.88 (2.13) |  | 11.3 (11.9) | 3.36 (3.76) |
| Python reference | runner_verification | 19.3 (20.0) |  | 247 (255) | 28.9 (30.1) |
| Python reference | workflow_start | 16.2 (16.9) |  | 219 (227) | 24.6 (25.5) |
| Chrome core (Node) | package_open_verify | 7.07 (9.24) | 54.7 (66.9) | 55.0 (63.4) | 9.89 (12.3) |
| Chrome core (Node) | authorization_receipt | 0.13 (0.16) | 0.15 (0.18) | 0.23 (0.27) | 0.14 (0.20) |
| Chrome core (Node) | compatibility_evaluation | 0.0968 (0.12) | 1.51 (1.74) | 2.61 (3.05) | 0.71 (1.13) |
| Chrome core (Node) | run_plan_preparation | 0.38 (0.44) | 3.06 (3.56) | 5.33 (6.02) | 1.59 (1.76) |
| Chrome core (Node) | host_revalidation_lease | 7.41 (8.59) | 55.3 (62.5) | 58.0 (65.4) | 10.9 (12.6) |
| Chrome core (Node) | runner_verification | 13.9 (16.8) | 107 (123) | 108 (123) | 19.7 (22.9) |
| Chrome core (Node) | workflow_start | 5.91 (7.19) | 44.6 (50.6) | 46.4 (52.5) | 7.30 (9.01) |

## Per-operation costs

| Arm | Cell | Python reference | Chrome core (Node) |
|---|---|---|---|
| compute_cold | fares | 2.76 (3.08) | 6.24 (6.51) |
| compute_warm | fares | 0.16 (0.18) | 6.09 (6.29) |
| consent_gate | gated_accepted | 0.0003 (0.0003) | 0.0003 (0.0003) |
| consent_gate | not_gated | 0.0002 (0.0002) | 0.0001 (0.0001) |
| network_enumerate | mesh-3 | 0.0163 (0.0172) | 0.0043 (0.0045) |
| network_enumerate | mesh-4 | 0.38 (0.40) | 0.11 (0.11) |
| network_enumerate | mesh-5 | 23.1 (23.6) | 6.24 (6.45) |
| network_enumerate | mesh-6 | 71.3 (72.8) | 20.4 (20.9) |
| network_enumerate | mesh-7 | 71.9 (73.2) | 20.3 (20.7) |
| network_enumerate | mesh-8 | 69.1 (70.3) | 20.7 (21.1) |
| network_enumerate | star-3 | 0.0073 (0.0076) | 0.0021 (0.0044) |
| network_enumerate | star-4 | 0.0242 (0.0278) | 0.0070 (0.0079) |
| network_enumerate | star-5 | 0.10 (0.11) | 0.0314 (0.0341) |
| network_enumerate | star-6 | 0.53 (0.56) | 0.16 (0.18) |
| network_enumerate | star-7 | 3.24 (3.85) | 1.04 (1.10) |
| network_enumerate | star-8 | 24.1 (24.6) | 7.81 (8.21) |
| network_route_data | mesh-3 | 0.0016 (0.0017) | 0.0002 (0.0002) |
| network_route_data | mesh-4 | 0.0019 (0.0020) | 0.0003 (0.0003) |
| network_route_data | mesh-5 | 0.0022 (0.0025) | 0.0003 (0.0003) |
| network_route_data | mesh-6 | 0.0025 (0.0026) | 0.0004 (0.0004) |
| network_route_data | mesh-7 | 0.0028 (0.0030) | 0.0004 (0.0005) |
| network_route_data | mesh-8 | 0.0031 (0.0031) | 0.0005 (0.0005) |
| network_route_data | star-3 | 0.0016 (0.0017) | 0.0002 (0.0006) |
| network_route_data | star-4 | 0.0019 (0.0020) | 0.0003 (0.0003) |
| network_route_data | star-5 | 0.0022 (0.0022) | 0.0003 (0.0004) |
| network_route_data | star-6 | 0.0025 (0.0026) | 0.0004 (0.0005) |
| network_route_data | star-7 | 0.0028 (0.0029) | 0.0005 (0.0006) |
| network_route_data | star-8 | 0.0030 (0.0032) | 0.0005 (0.0006) |
| network_worst_case | mesh-3 | 0.0178 (0.0180) | 0.0043 (0.0046) |
| network_worst_case | mesh-4 | 0.0230 (0.0234) | 0.0054 (0.0057) |
| network_worst_case | mesh-5 | 0.0291 (0.0304) | 0.0069 (0.0072) |
| network_worst_case | mesh-6 | 0.0366 (0.0374) | 0.0083 (0.0086) |
| network_worst_case | mesh-7 | 0.0451 (0.0458) | 0.0095 (0.0100) |
| network_worst_case | mesh-8 | 0.0545 (0.0574) | 0.0108 (0.0117) |
| network_worst_case | star-3 | 0.0182 (0.0188) | 0.0060 (0.0089) |
| network_worst_case | star-4 | 0.0234 (0.0239) | 0.0065 (0.0083) |
| network_worst_case | star-5 | 0.0287 (0.0300) | 0.0083 (0.0091) |
| network_worst_case | star-6 | 0.0344 (0.0358) | 0.0093 (0.0100) |
| network_worst_case | star-7 | 0.0401 (0.0432) | 0.0103 (0.0107) |
| network_worst_case | star-8 | 0.0460 (0.0492) | 0.0110 (0.0114) |
| scan_model_request | 1024KiB-10 | 22.5 (22.8) | 5.49 (5.81) |
| scan_model_request | 1024KiB-100 | 173 (174) | 42.0 (42.5) |
| scan_model_request | 1024KiB-1000 | 1678 (1686) | 406 (410) |
| scan_model_request | 16KiB-10 | 0.41 (0.43) | 0.0781 (0.0937) |
| scan_model_request | 16KiB-100 | 3.07 (3.11) | 0.59 (0.62) |
| scan_model_request | 16KiB-1000 | 29.8 (30.4) | 5.67 (5.77) |
| scan_model_request | 1KiB-10 | 0.0295 (0.0358) | 0.0092 (0.0120) |
| scan_model_request | 1KiB-100 | 0.24 (0.25) | 0.0353 (0.0670) |
| scan_model_request | 1KiB-1000 | 2.30 (2.35) | 0.35 (0.36) |
| scan_model_request | 256KiB-10 | 6.33 (6.47) | 1.33 (1.39) |
| scan_model_request | 256KiB-100 | 46.6 (49.5) | 10.3 (10.5) |
| scan_model_request | 256KiB-1000 | 449 (480) | 101 (102) |
| scan_tool_arguments | 1024KiB-10 | 22.6 (22.9) | 5.51 (5.83) |
| scan_tool_arguments | 1024KiB-100 | 173 (174) | 42.1 (42.8) |
| scan_tool_arguments | 1024KiB-1000 | 1678 (1689) | 407 (412) |
| scan_tool_arguments | 16KiB-10 | 0.41 (0.43) | 0.0760 (0.0840) |
| scan_tool_arguments | 16KiB-100 | 3.12 (3.19) | 0.59 (0.61) |
| scan_tool_arguments | 16KiB-1000 | 29.8 (30.4) | 5.68 (5.78) |
| scan_tool_arguments | 1KiB-10 | 0.0307 (0.0357) | 0.0081 (0.0085) |
| scan_tool_arguments | 1KiB-100 | 0.24 (0.25) | 0.0352 (0.0368) |
| scan_tool_arguments | 1KiB-1000 | 2.34 (2.39) | 0.35 (0.37) |
| scan_tool_arguments | 256KiB-10 | 6.34 (6.46) | 1.33 (1.41) |
| scan_tool_arguments | 256KiB-100 | 46.6 (46.8) | 10.3 (10.6) |
| scan_tool_arguments | 256KiB-1000 | 421 (475) | 102 (103) |
| transition_check | travel-network | 0.0085 (0.0090) | 0.0092 (0.0220) |

## Facts of the per-operation inputs

```json
{
  "py": {
    "compute": {
      "engine": "wasmtime-py/49.0.0",
      "output": "{\"currency\":\"USD\",\"lines\":[{\"label\":\"Fare\",\"amount_cents\":61200,\"quantity\":1,\"total_cents\":61200},{\"label\":\"Seat\",\"amount_cents\":2500,\"quantity\":1,\"total_cents\":2500}],\"subtotal_cents\":63700,\"tax_cents\":5160,\"total_cents\":68860}"
    },
    "consent": {
      "gated_permissions": [
        "booking.simulate_purchase"
      ]
    },
    "networks": {
      "mesh-3": {
        "effort_exceeded": false,
        "max_activations": 5,
        "model_calls": 6,
        "roles": 3,
        "tokens": 36000,
        "topology": "mesh",
        "walks": 9
      },
      "mesh-4": {
        "effort_exceeded": false,
        "max_activations": 7,
        "model_calls": 8,
        "roles": 4,
        "tokens": 48000,
        "topology": "mesh",
        "walks": 142
      },
      "mesh-5": {
        "effort_exceeded": false,
        "max_activations": 9,
        "model_calls": 10,
        "roles": 5,
        "tokens": 48000,
        "topology": "mesh",
        "walks": 6653
      },
      "mesh-6": {
        "effort_exceeded": true,
        "max_activations": 11,
        "model_calls": 12,
        "roles": 6,
        "tokens": 48000,
        "topology": "mesh",
        "walks": null
      },
      "mesh-7": {
        "effort_exceeded": true,
        "max_activations": 13,
        "model_calls": 14,
        "roles": 7,
        "tokens": 48000,
        "topology": "mesh",
        "walks": null
      },
      "mesh-8": {
        "effort_exceeded": true,
        "max_activations": 15,
        "model_calls": 16,
        "roles": 8,
        "tokens": 48000,
        "topology": "mesh",
        "walks": null
      },
      "star-3": {
        "effort_exceeded": false,
        "max_activations": 5,
        "model_calls": 6,
        "roles": 3,
        "tokens": 36000,
        "topology": "star",
        "walks": 5
      },
      "star-4": {
        "effort_exceeded": false,
        "max_activations": 7,
        "model_calls": 8,
        "roles": 4,
        "tokens": 48000,
        "topology": "star",
        "walks": 16
      },
      "star-5": {
        "effort_exceeded": false,
        "max_activations": 9,
        "model_calls": 10,
        "roles": 5,
        "tokens": 48000,
        "topology": "star",
        "walks": 65
      },
      "star-6": {
        "effort_exceeded": false,
        "max_activations": 11,
        "model_calls": 12,
        "roles": 6,
        "tokens": 48000,
        "topology": "star",
        "walks": 326
      },
      "star-7": {
        "effort_exceeded": false,
        "max_activations": 13,
        "model_calls": 14,
        "roles": 7,
        "tokens": 48000,
        "topology": "star",
        "walks": 1957
      },
      "star-8": {
        "effort_exceeded": false,
        "max_activations": 15,
        "model_calls": 16,
        "roles": 8,
        "tokens": 48000,
        "topology": "star",
        "walks": 13700
      }
    },
    "transition": {
      "audit_events": 1051
    }
  },
  "ts": {
    "compute": {
      "engine": "node/v26.9.0",
      "output": "{\"currency\":\"USD\",\"lines\":[{\"label\":\"Fare\",\"amount_cents\":61200,\"quantity\":1,\"total_cents\":61200},{\"label\":\"Seat\",\"amount_cents\":2500,\"quantity\":1,\"total_cents\":2500}],\"subtotal_cents\":63700,\"tax_cents\":5160,\"total_cents\":68860}"
    },
    "consent": {
      "gated_permissions": [
        "booking.simulate_purchase"
      ]
    },
    "networks": {
      "mesh-3": {
        "effort_exceeded": false,
        "max_activations": 5,
        "model_calls": 6,
        "roles": 3,
        "tokens": 36000,
        "topology": "mesh",
        "walks": 9
      },
      "mesh-4": {
        "effort_exceeded": false,
        "max_activations": 7,
        "model_calls": 8,
        "roles": 4,
        "tokens": 48000,
        "topology": "mesh",
        "walks": 142
      },
      "mesh-5": {
        "effort_exceeded": false,
        "max_activations": 9,
        "model_calls": 10,
        "roles": 5,
        "tokens": 48000,
        "topology": "mesh",
        "walks": 6653
      },
      "mesh-6": {
        "effort_exceeded": true,
        "max_activations": 11,
        "model_calls": 12,
        "roles": 6,
        "tokens": 48000,
        "topology": "mesh",
        "walks": null
      },
      "mesh-7": {
        "effort_exceeded": true,
        "max_activations": 13,
        "model_calls": 14,
        "roles": 7,
        "tokens": 48000,
        "topology": "mesh",
        "walks": null
      },
      "mesh-8": {
        "effort_exceeded": true,
        "max_activations": 15,
        "model_calls": 16,
        "roles": 8,
        "tokens": 48000,
        "topology": "mesh",
        "walks": null
      },
      "star-3": {
        "effort_exceeded": false,
        "max_activations": 5,
        "model_calls": 6,
        "roles": 3,
        "tokens": 36000,
        "topology": "star",
        "walks": 5
      },
      "star-4": {
        "effort_exceeded": false,
        "max_activations": 7,
        "model_calls": 8,
        "roles": 4,
        "tokens": 48000,
        "topology": "star",
        "walks": 16
      },
      "star-5": {
        "effort_exceeded": false,
        "max_activations": 9,
        "model_calls": 10,
        "roles": 5,
        "tokens": 48000,
        "topology": "star",
        "walks": 65
      },
      "star-6": {
        "effort_exceeded": false,
        "max_activations": 11,
        "model_calls": 12,
        "roles": 6,
        "tokens": 48000,
        "topology": "star",
        "walks": 326
      },
      "star-7": {
        "effort_exceeded": false,
        "max_activations": 13,
        "model_calls": 14,
        "roles": 7,
        "tokens": 48000,
        "topology": "star",
        "walks": 1957
      },
      "star-8": {
        "effort_exceeded": false,
        "max_activations": 15,
        "model_calls": 16,
        "roles": 8,
        "tokens": 48000,
        "topology": "star",
        "walks": 13700
      }
    },
    "transition": {
      "audit_events": 1051
    }
  }
}
```

v1's RQ2 series (`results/2026-10-03T16-14-20Z_paper-webair-pooled`) is a different implementation, host and package set: cited beside, never pooled (D-019).

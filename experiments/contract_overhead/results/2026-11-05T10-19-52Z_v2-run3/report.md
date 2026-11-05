# Contract overhead v2: 2026-11-05T10-19-52Z_v2-run3

Median (p95) in milliseconds; every number computed by `aggregate_v2.py` from the raw samples.

- Source: `experiments/contract_overhead/results/2026-11-05T10-19-52Z_v2-run3`

- Commit `8334b4c290c169b9c6e087f3188d7185d51cf647`; benchmark 2.0.0; protocol sha256 `80c15e8959b6…`.

## Groups and total (Tab. 9)

| Runtime | Quantity | meeting-agenda | literature-review | webair | travel-network |
|---|---|---|---|---|---|
| Python reference | Package verification | 20.2 (20.8) |  | 246 (252) | 29.9 (30.7) |
| Python reference | Authorization / binding | 0.78 (0.81) |  | 3.86 (3.95) | 1.38 (1.43) |
| Python reference | Run Plan preparation | 1.19 (1.24) |  | 6.28 (6.41) | 2.22 (2.33) |
| Python reference | Pre-execution revalidation | 37.3 (38.1) |  | 479 (485) | 56.8 (58.1) |
| Python reference | total_pre_execution | 59.4 (60.7) |  | 735 (742) | 90.3 (92.3) |
| Chrome core (Node) | Package verification | 7.01 (8.94) | 54.2 (62.8) | 54.6 (61.2) | 9.75 (11.9) |
| Chrome core (Node) | Authorization / binding | 0.23 (0.26) | 1.63 (1.84) | 2.79 (3.18) | 0.83 (1.23) |
| Chrome core (Node) | Run Plan preparation | 0.38 (0.41) | 3.01 (3.48) | 5.23 (5.67) | 1.58 (2.02) |
| Chrome core (Node) | Pre-execution revalidation | 26.8 (29.8) | 207 (227) | 212 (232) | 37.7 (42.3) |
| Chrome core (Node) | total_pre_execution | 34.4 (39.3) | 267 (288) | 275 (295) | 50.2 (56.2) |

## Stages

| Runtime | Quantity | meeting-agenda | literature-review | webair | travel-network |
|---|---|---|---|---|---|
| Python reference | package_open_verify | 20.2 (20.8) |  | 246 (252) | 29.9 (30.7) |
| Python reference | authorization_receipt | 0.50 (0.53) |  | 0.73 (0.76) | 0.52 (0.54) |
| Python reference | compatibility_evaluation | 0.27 (0.29) |  | 3.14 (3.19) | 0.86 (0.89) |
| Python reference | run_plan_preparation | 1.19 (1.24) |  | 6.28 (6.41) | 2.22 (2.33) |
| Python reference | host_revalidation_lease | 1.91 (2.14) |  | 11.2 (12.1) | 3.41 (3.82) |
| Python reference | runner_verification | 19.2 (19.7) |  | 246 (253) | 28.8 (29.5) |
| Python reference | workflow_start | 16.2 (16.6) |  | 218 (225) | 24.5 (25.1) |
| Chrome core (Node) | package_open_verify | 7.01 (8.94) | 54.2 (62.8) | 54.6 (61.2) | 9.75 (11.9) |
| Chrome core (Node) | authorization_receipt | 0.13 (0.15) | 0.15 (0.17) | 0.22 (0.26) | 0.13 (0.16) |
| Chrome core (Node) | compatibility_evaluation | 0.0958 (0.11) | 1.48 (1.67) | 2.57 (2.94) | 0.70 (1.10) |
| Chrome core (Node) | run_plan_preparation | 0.38 (0.41) | 3.01 (3.48) | 5.23 (5.67) | 1.58 (2.02) |
| Chrome core (Node) | host_revalidation_lease | 7.29 (8.18) | 55.1 (59.4) | 57.6 (62.0) | 10.8 (12.0) |
| Chrome core (Node) | runner_verification | 13.7 (15.4) | 106 (123) | 107 (120) | 19.5 (22.2) |
| Chrome core (Node) | workflow_start | 5.90 (6.49) | 44.2 (48.5) | 45.8 (50.0) | 7.49 (8.57) |

## Per-operation costs

| Arm | Cell | Python reference | Chrome core (Node) |
|---|---|---|---|
| compute_cold | fares | 2.78 (3.09) | 6.30 (6.64) |
| compute_warm | fares | 0.16 (0.17) | 6.13 (6.37) |
| consent_gate | gated_accepted | 0.0003 (0.0003) | 0.0001 (0.0003) |
| consent_gate | not_gated | 0.0002 (0.0002) | 0.0001 (0.0001) |
| network_enumerate | mesh-3 | 0.0162 (0.0168) | 0.0043 (0.0045) |
| network_enumerate | mesh-4 | 0.36 (0.38) | 0.10 (0.11) |
| network_enumerate | mesh-5 | 22.5 (23.1) | 6.34 (6.50) |
| network_enumerate | mesh-6 | 71.0 (71.8) | 20.9 (21.5) |
| network_enumerate | mesh-7 | 69.7 (70.7) | 20.4 (20.8) |
| network_enumerate | mesh-8 | 67.3 (68.4) | 20.9 (21.3) |
| network_enumerate | star-3 | 0.0072 (0.0075) | 0.0020 (0.0051) |
| network_enumerate | star-4 | 0.0238 (0.0245) | 0.0068 (0.0077) |
| network_enumerate | star-5 | 0.10 (0.10) | 0.0301 (0.0312) |
| network_enumerate | star-6 | 0.53 (0.55) | 0.16 (0.17) |
| network_enumerate | star-7 | 3.25 (3.89) | 1.05 (1.10) |
| network_enumerate | star-8 | 24.0 (24.4) | 7.69 (8.14) |
| network_route_data | mesh-3 | 0.0016 (0.0018) | 0.0002 (0.0002) |
| network_route_data | mesh-4 | 0.0019 (0.0020) | 0.0003 (0.0003) |
| network_route_data | mesh-5 | 0.0022 (0.0023) | 0.0003 (0.0003) |
| network_route_data | mesh-6 | 0.0025 (0.0026) | 0.0004 (0.0004) |
| network_route_data | mesh-7 | 0.0028 (0.0030) | 0.0004 (0.0005) |
| network_route_data | mesh-8 | 0.0030 (0.0031) | 0.0005 (0.0006) |
| network_route_data | star-3 | 0.0016 (0.0018) | 0.0002 (0.0005) |
| network_route_data | star-4 | 0.0019 (0.0020) | 0.0003 (0.0003) |
| network_route_data | star-5 | 0.0022 (0.0022) | 0.0003 (0.0004) |
| network_route_data | star-6 | 0.0025 (0.0026) | 0.0004 (0.0005) |
| network_route_data | star-7 | 0.0028 (0.0028) | 0.0005 (0.0006) |
| network_route_data | star-8 | 0.0031 (0.0032) | 0.0005 (0.0006) |
| network_worst_case | mesh-3 | 0.0181 (0.0190) | 0.0042 (0.0045) |
| network_worst_case | mesh-4 | 0.0230 (0.0241) | 0.0053 (0.0057) |
| network_worst_case | mesh-5 | 0.0290 (0.0326) | 0.0067 (0.0071) |
| network_worst_case | mesh-6 | 0.0364 (0.0372) | 0.0080 (0.0084) |
| network_worst_case | mesh-7 | 0.0445 (0.0489) | 0.0093 (0.0097) |
| network_worst_case | mesh-8 | 0.0550 (0.0562) | 0.0104 (0.0107) |
| network_worst_case | star-3 | 0.0181 (0.0187) | 0.0059 (0.0089) |
| network_worst_case | star-4 | 0.0230 (0.0237) | 0.0064 (0.0081) |
| network_worst_case | star-5 | 0.0282 (0.0285) | 0.0081 (0.0092) |
| network_worst_case | star-6 | 0.0343 (0.0376) | 0.0093 (0.0099) |
| network_worst_case | star-7 | 0.0395 (0.0419) | 0.0101 (0.0105) |
| network_worst_case | star-8 | 0.0455 (0.0460) | 0.0108 (0.0112) |
| scan_model_request | 1024KiB-10 | 22.5 (22.8) | 5.44 (5.79) |
| scan_model_request | 1024KiB-100 | 173 (174) | 41.4 (41.9) |
| scan_model_request | 1024KiB-1000 | 1678 (1692) | 401 (404) |
| scan_model_request | 16KiB-10 | 0.35 (0.36) | 0.0763 (0.0917) |
| scan_model_request | 16KiB-100 | 2.73 (2.78) | 0.59 (0.61) |
| scan_model_request | 16KiB-1000 | 26.4 (26.7) | 5.68 (5.78) |
| scan_model_request | 1KiB-10 | 0.0273 (0.0275) | 0.0093 (0.0119) |
| scan_model_request | 1KiB-100 | 0.21 (0.22) | 0.0354 (0.0681) |
| scan_model_request | 1KiB-1000 | 2.05 (2.09) | 0.35 (0.36) |
| scan_model_request | 256KiB-10 | 5.60 (5.70) | 1.33 (1.39) |
| scan_model_request | 256KiB-100 | 43.6 (43.9) | 10.3 (10.5) |
| scan_model_request | 256KiB-1000 | 421 (423) | 99.9 (101) |
| scan_tool_arguments | 1024KiB-10 | 22.5 (22.7) | 5.47 (5.83) |
| scan_tool_arguments | 1024KiB-100 | 173 (175) | 41.5 (42.1) |
| scan_tool_arguments | 1024KiB-1000 | 1678 (1693) | 401 (404) |
| scan_tool_arguments | 16KiB-10 | 0.35 (0.36) | 0.0762 (0.0811) |
| scan_tool_arguments | 16KiB-100 | 2.73 (2.77) | 0.59 (0.61) |
| scan_tool_arguments | 16KiB-1000 | 26.4 (26.6) | 5.66 (5.76) |
| scan_tool_arguments | 1KiB-10 | 0.0273 (0.0275) | 0.0083 (0.0088) |
| scan_tool_arguments | 1KiB-100 | 0.21 (0.22) | 0.0352 (0.0368) |
| scan_tool_arguments | 1KiB-1000 | 2.04 (2.08) | 0.35 (0.36) |
| scan_tool_arguments | 256KiB-10 | 5.60 (5.68) | 1.33 (1.40) |
| scan_tool_arguments | 256KiB-100 | 43.6 (43.9) | 10.3 (10.8) |
| scan_tool_arguments | 256KiB-1000 | 421 (423) | 100.0 (101) |
| transition_check | travel-network | 0.0086 (0.0102) | 0.0092 (0.0218) |

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

# Contract overhead v2, pooled: 2026-11-05T12-40-00Z_v2-pooled

Median (p95) in milliseconds; every number computed by `aggregate_v2.py` from the raw samples.

- Source: `experiments/contract_overhead/results/2026-11-05T05-45-14Z_v2-run1`
- Source: `experiments/contract_overhead/results/2026-11-05T08-03-15Z_v2-run2`
- Source: `experiments/contract_overhead/results/2026-11-05T10-19-52Z_v2-run3`

- Commit `8334b4c290c169b9c6e087f3188d7185d51cf647`; benchmark 2.0.0; protocol sha256 `80c15e8959b6…`.

## Groups and total (Tab. 9)

| Runtime | Quantity | meeting-agenda | literature-review | webair | travel-network |
|---|---|---|---|---|---|
| Python reference | Package verification | 20.2 (20.8) |  | 247 (253) | 29.9 (30.8) |
| Python reference | Authorization / binding | 0.78 (0.82) |  | 3.87 (3.97) | 1.39 (1.44) |
| Python reference | Run Plan preparation | 1.20 (1.24) |  | 6.29 (6.43) | 2.23 (2.36) |
| Python reference | Pre-execution revalidation | 37.4 (38.5) |  | 481 (488) | 56.8 (58.5) |
| Python reference | total_pre_execution | 59.5 (61.1) |  | 738 (748) | 90.4 (93.0) |
| Chrome core (Node) | Package verification | 7.05 (9.07) | 54.4 (64.5) | 54.8 (62.9) | 9.83 (12.2) |
| Chrome core (Node) | Authorization / binding | 0.23 (0.27) | 1.65 (1.98) | 2.81 (3.26) | 0.84 (1.25) |
| Chrome core (Node) | Run Plan preparation | 0.38 (0.42) | 3.03 (3.52) | 5.25 (5.83) | 1.58 (1.95) |
| Chrome core (Node) | Pre-execution revalidation | 26.9 (31.6) | 207 (229) | 212 (234) | 37.8 (43.2) |
| Chrome core (Node) | total_pre_execution | 34.6 (41.0) | 267 (290) | 277 (300) | 50.3 (57.4) |

## Stages

| Runtime | Quantity | meeting-agenda | literature-review | webair | travel-network |
|---|---|---|---|---|---|
| Python reference | package_open_verify | 20.2 (20.8) |  | 247 (253) | 29.9 (30.8) |
| Python reference | authorization_receipt | 0.51 (0.53) |  | 0.73 (0.77) | 0.52 (0.55) |
| Python reference | compatibility_evaluation | 0.28 (0.29) |  | 3.14 (3.22) | 0.87 (0.90) |
| Python reference | run_plan_preparation | 1.20 (1.24) |  | 6.29 (6.43) | 2.23 (2.36) |
| Python reference | host_revalidation_lease | 1.90 (2.14) |  | 11.3 (12.2) | 3.39 (3.80) |
| Python reference | runner_verification | 19.2 (19.9) |  | 247 (254) | 28.9 (29.7) |
| Python reference | workflow_start | 16.2 (16.8) |  | 219 (226) | 24.5 (25.3) |
| Chrome core (Node) | package_open_verify | 7.05 (9.07) | 54.4 (64.5) | 54.8 (62.9) | 9.83 (12.2) |
| Chrome core (Node) | authorization_receipt | 0.13 (0.15) | 0.15 (0.18) | 0.22 (0.26) | 0.14 (0.17) |
| Chrome core (Node) | compatibility_evaluation | 0.0963 (0.12) | 1.49 (1.72) | 2.59 (3.02) | 0.70 (1.11) |
| Chrome core (Node) | run_plan_preparation | 0.38 (0.42) | 3.03 (3.52) | 5.25 (5.83) | 1.58 (1.95) |
| Chrome core (Node) | host_revalidation_lease | 7.36 (8.39) | 55.1 (60.8) | 57.8 (64.0) | 10.9 (12.3) |
| Chrome core (Node) | runner_verification | 13.8 (16.3) | 106 (123) | 108 (123) | 19.6 (22.5) |
| Chrome core (Node) | workflow_start | 5.90 (6.82) | 44.5 (49.8) | 46.2 (51.6) | 7.33 (8.89) |

## Per-operation costs

| Arm | Cell | Python reference | Chrome core (Node) |
|---|---|---|---|
| compute_cold | fares | 2.77 (3.10) | 6.29 (6.61) |
| compute_warm | fares | 0.16 (0.18) | 6.13 (6.36) |
| consent_gate | gated_accepted | 0.0003 (0.0003) | 0.0002 (0.0003) |
| consent_gate | not_gated | 0.0002 (0.0002) | 0.0001 (0.0001) |
| network_enumerate | mesh-3 | 0.0162 (0.0169) | 0.0043 (0.0045) |
| network_enumerate | mesh-4 | 0.37 (0.39) | 0.10 (0.11) |
| network_enumerate | mesh-5 | 23.0 (23.5) | 6.28 (6.48) |
| network_enumerate | mesh-6 | 71.2 (72.5) | 20.6 (21.2) |
| network_enumerate | mesh-7 | 70.5 (72.7) | 20.3 (20.8) |
| network_enumerate | mesh-8 | 68.5 (69.9) | 20.8 (21.2) |
| network_enumerate | star-3 | 0.0072 (0.0076) | 0.0020 (0.0044) |
| network_enumerate | star-4 | 0.0240 (0.0256) | 0.0069 (0.0078) |
| network_enumerate | star-5 | 0.10 (0.11) | 0.0304 (0.0332) |
| network_enumerate | star-6 | 0.53 (0.56) | 0.16 (0.17) |
| network_enumerate | star-7 | 3.24 (3.87) | 1.05 (1.10) |
| network_enumerate | star-8 | 24.0 (24.5) | 7.86 (8.25) |
| network_route_data | mesh-3 | 0.0016 (0.0017) | 0.0002 (0.0002) |
| network_route_data | mesh-4 | 0.0019 (0.0020) | 0.0003 (0.0003) |
| network_route_data | mesh-5 | 0.0022 (0.0023) | 0.0003 (0.0003) |
| network_route_data | mesh-6 | 0.0025 (0.0026) | 0.0004 (0.0004) |
| network_route_data | mesh-7 | 0.0028 (0.0030) | 0.0004 (0.0005) |
| network_route_data | mesh-8 | 0.0030 (0.0031) | 0.0005 (0.0006) |
| network_route_data | star-3 | 0.0016 (0.0017) | 0.0002 (0.0006) |
| network_route_data | star-4 | 0.0019 (0.0020) | 0.0003 (0.0003) |
| network_route_data | star-5 | 0.0022 (0.0022) | 0.0003 (0.0004) |
| network_route_data | star-6 | 0.0025 (0.0026) | 0.0004 (0.0005) |
| network_route_data | star-7 | 0.0028 (0.0029) | 0.0005 (0.0005) |
| network_route_data | star-8 | 0.0030 (0.0032) | 0.0005 (0.0006) |
| network_worst_case | mesh-3 | 0.0179 (0.0187) | 0.0043 (0.0045) |
| network_worst_case | mesh-4 | 0.0230 (0.0236) | 0.0054 (0.0085) |
| network_worst_case | mesh-5 | 0.0290 (0.0308) | 0.0067 (0.0071) |
| network_worst_case | mesh-6 | 0.0365 (0.0378) | 0.0081 (0.0085) |
| network_worst_case | mesh-7 | 0.0450 (0.0475) | 0.0094 (0.0115) |
| network_worst_case | mesh-8 | 0.0548 (0.0576) | 0.0105 (0.0115) |
| network_worst_case | star-3 | 0.0181 (0.0187) | 0.0059 (0.0089) |
| network_worst_case | star-4 | 0.0230 (0.0238) | 0.0064 (0.0080) |
| network_worst_case | star-5 | 0.0283 (0.0296) | 0.0081 (0.0091) |
| network_worst_case | star-6 | 0.0343 (0.0367) | 0.0093 (0.0099) |
| network_worst_case | star-7 | 0.0398 (0.0433) | 0.0101 (0.0106) |
| network_worst_case | star-8 | 0.0456 (0.0485) | 0.0109 (0.0113) |
| scan_model_request | 1024KiB-10 | 22.5 (22.8) | 5.46 (5.79) |
| scan_model_request | 1024KiB-100 | 173 (174) | 41.5 (42.3) |
| scan_model_request | 1024KiB-1000 | 1679 (1689) | 401 (409) |
| scan_model_request | 16KiB-10 | 0.36 (0.42) | 0.0765 (0.0917) |
| scan_model_request | 16KiB-100 | 2.74 (3.09) | 0.59 (0.61) |
| scan_model_request | 16KiB-1000 | 26.5 (30.3) | 5.68 (5.78) |
| scan_model_request | 1KiB-10 | 0.0280 (0.0335) | 0.0092 (0.0120) |
| scan_model_request | 1KiB-100 | 0.21 (0.25) | 0.0354 (0.0674) |
| scan_model_request | 1KiB-1000 | 2.06 (2.33) | 0.35 (0.36) |
| scan_model_request | 256KiB-10 | 5.61 (6.43) | 1.33 (1.40) |
| scan_model_request | 256KiB-100 | 43.8 (48.9) | 10.3 (10.5) |
| scan_model_request | 256KiB-1000 | 421 (478) | 100 (102) |
| scan_tool_arguments | 1024KiB-10 | 22.5 (22.8) | 5.47 (5.83) |
| scan_tool_arguments | 1024KiB-100 | 173 (174) | 41.5 (42.5) |
| scan_tool_arguments | 1024KiB-1000 | 1679 (1692) | 401 (410) |
| scan_tool_arguments | 16KiB-10 | 0.36 (0.42) | 0.0762 (0.0834) |
| scan_tool_arguments | 16KiB-100 | 2.74 (3.16) | 0.59 (0.61) |
| scan_tool_arguments | 16KiB-1000 | 26.5 (30.3) | 5.67 (5.76) |
| scan_tool_arguments | 1KiB-10 | 0.0276 (0.0335) | 0.0082 (0.0087) |
| scan_tool_arguments | 1KiB-100 | 0.21 (0.25) | 0.0352 (0.0374) |
| scan_tool_arguments | 1KiB-1000 | 2.06 (2.37) | 0.35 (0.37) |
| scan_tool_arguments | 256KiB-10 | 5.61 (6.43) | 1.33 (1.40) |
| scan_tool_arguments | 256KiB-100 | 43.7 (46.7) | 10.3 (10.6) |
| scan_tool_arguments | 256KiB-1000 | 421 (428) | 100 (102) |
| transition_check | travel-network | 0.0085 (0.0092) | 0.0092 (0.0258) |

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

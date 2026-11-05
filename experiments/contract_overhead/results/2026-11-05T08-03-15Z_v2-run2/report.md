# Contract overhead v2: 2026-11-05T08-03-15Z_v2-run2

Median (p95) in milliseconds; every number computed by `aggregate_v2.py` from the raw samples.

- Source: `experiments/contract_overhead/results/2026-11-05T08-03-15Z_v2-run2`

- Commit `8334b4c290c169b9c6e087f3188d7185d51cf647`; benchmark 2.0.0; protocol sha256 `80c15e8959b6…`.

## Groups and total (Tab. 9)

| Runtime | Quantity | meeting-agenda | literature-review | webair | travel-network |
|---|---|---|---|---|---|
| Python reference | Package verification | 20.2 (20.8) |  | 247 (254) | 29.9 (30.9) |
| Python reference | Authorization / binding | 0.78 (0.81) |  | 3.87 (3.97) | 1.39 (1.44) |
| Python reference | Run Plan preparation | 1.20 (1.24) |  | 6.29 (6.41) | 2.24 (2.36) |
| Python reference | Pre-execution revalidation | 37.4 (38.4) |  | 482 (489) | 56.9 (58.5) |
| Python reference | total_pre_execution | 59.5 (61.1) |  | 740 (748) | 90.5 (93.0) |
| Chrome core (Node) | Package verification | 7.05 (9.10) | 54.4 (64.6) | 54.7 (63.1) | 9.85 (12.3) |
| Chrome core (Node) | Authorization / binding | 0.23 (0.27) | 1.64 (2.00) | 2.81 (3.26) | 0.84 (1.25) |
| Chrome core (Node) | Run Plan preparation | 0.38 (0.42) | 3.02 (3.50) | 5.22 (5.78) | 1.56 (1.69) |
| Chrome core (Node) | Pre-execution revalidation | 26.9 (30.9) | 207 (226) | 213 (233) | 37.9 (42.1) |
| Chrome core (Node) | total_pre_execution | 34.6 (40.7) | 267 (286) | 277 (296) | 50.4 (56.5) |

## Stages

| Runtime | Quantity | meeting-agenda | literature-review | webair | travel-network |
|---|---|---|---|---|---|
| Python reference | package_open_verify | 20.2 (20.8) |  | 247 (254) | 29.9 (30.9) |
| Python reference | authorization_receipt | 0.51 (0.53) |  | 0.73 (0.76) | 0.52 (0.55) |
| Python reference | compatibility_evaluation | 0.28 (0.29) |  | 3.14 (3.22) | 0.87 (0.91) |
| Python reference | run_plan_preparation | 1.20 (1.24) |  | 6.29 (6.41) | 2.24 (2.36) |
| Python reference | host_revalidation_lease | 1.91 (2.14) |  | 11.3 (12.3) | 3.41 (3.85) |
| Python reference | runner_verification | 19.2 (19.9) |  | 247 (255) | 28.9 (29.6) |
| Python reference | workflow_start | 16.2 (16.8) |  | 220 (227) | 24.5 (25.3) |
| Chrome core (Node) | package_open_verify | 7.05 (9.10) | 54.4 (64.6) | 54.7 (63.1) | 9.85 (12.3) |
| Chrome core (Node) | authorization_receipt | 0.13 (0.15) | 0.15 (0.17) | 0.22 (0.26) | 0.13 (0.17) |
| Chrome core (Node) | compatibility_evaluation | 0.0962 (0.12) | 1.49 (1.73) | 2.58 (3.03) | 0.70 (1.11) |
| Chrome core (Node) | run_plan_preparation | 0.38 (0.42) | 3.02 (3.50) | 5.22 (5.78) | 1.56 (1.69) |
| Chrome core (Node) | host_revalidation_lease | 7.37 (8.12) | 55.1 (58.9) | 57.9 (62.3) | 10.9 (12.0) |
| Chrome core (Node) | runner_verification | 13.8 (16.1) | 106 (119) | 108 (120) | 19.7 (22.1) |
| Chrome core (Node) | workflow_start | 5.87 (6.54) | 44.7 (48.3) | 46.4 (49.6) | 7.31 (9.03) |

## Per-operation costs

| Arm | Cell | Python reference | Chrome core (Node) |
|---|---|---|---|
| compute_cold | fares | 2.76 (3.11) | 6.34 (6.65) |
| compute_warm | fares | 0.16 (0.17) | 6.18 (6.41) |
| consent_gate | gated_accepted | 0.0003 (0.0003) | 0.0002 (0.0003) |
| consent_gate | not_gated | 0.0002 (0.0002) | 0.0000 (0.0001) |
| network_enumerate | mesh-3 | 0.0160 (0.0166) | 0.0043 (0.0055) |
| network_enumerate | mesh-4 | 0.37 (0.38) | 0.10 (0.11) |
| network_enumerate | mesh-5 | 23.1 (23.5) | 6.23 (6.44) |
| network_enumerate | mesh-6 | 71.4 (72.8) | 20.5 (21.1) |
| network_enumerate | mesh-7 | 70.4 (71.6) | 20.2 (20.8) |
| network_enumerate | mesh-8 | 68.5 (69.6) | 20.7 (21.1) |
| network_enumerate | star-3 | 0.0072 (0.0077) | 0.0020 (0.0033) |
| network_enumerate | star-4 | 0.0239 (0.0245) | 0.0068 (0.0075) |
| network_enumerate | star-5 | 0.10 (0.11) | 0.0302 (0.0334) |
| network_enumerate | star-6 | 0.52 (0.55) | 0.16 (0.18) |
| network_enumerate | star-7 | 3.23 (3.84) | 1.05 (1.11) |
| network_enumerate | star-8 | 24.0 (24.4) | 7.90 (8.30) |
| network_route_data | mesh-3 | 0.0016 (0.0017) | 0.0002 (0.0002) |
| network_route_data | mesh-4 | 0.0019 (0.0019) | 0.0003 (0.0003) |
| network_route_data | mesh-5 | 0.0021 (0.0023) | 0.0003 (0.0003) |
| network_route_data | mesh-6 | 0.0025 (0.0027) | 0.0004 (0.0004) |
| network_route_data | mesh-7 | 0.0028 (0.0030) | 0.0004 (0.0009) |
| network_route_data | mesh-8 | 0.0030 (0.0030) | 0.0005 (0.0007) |
| network_route_data | star-3 | 0.0016 (0.0017) | 0.0002 (0.0006) |
| network_route_data | star-4 | 0.0019 (0.0019) | 0.0003 (0.0004) |
| network_route_data | star-5 | 0.0021 (0.0022) | 0.0003 (0.0004) |
| network_route_data | star-6 | 0.0025 (0.0025) | 0.0004 (0.0005) |
| network_route_data | star-7 | 0.0028 (0.0029) | 0.0005 (0.0005) |
| network_route_data | star-8 | 0.0030 (0.0032) | 0.0005 (0.0005) |
| network_worst_case | mesh-3 | 0.0179 (0.0183) | 0.0041 (0.0044) |
| network_worst_case | mesh-4 | 0.0228 (0.0231) | 0.0054 (0.0094) |
| network_worst_case | mesh-5 | 0.0288 (0.0292) | 0.0067 (0.0070) |
| network_worst_case | mesh-6 | 0.0361 (0.0393) | 0.0080 (0.0083) |
| network_worst_case | mesh-7 | 0.0450 (0.0468) | 0.0092 (0.0120) |
| network_worst_case | mesh-8 | 0.0548 (0.0579) | 0.0105 (0.0129) |
| network_worst_case | star-3 | 0.0180 (0.0185) | 0.0057 (0.0085) |
| network_worst_case | star-4 | 0.0229 (0.0234) | 0.0063 (0.0077) |
| network_worst_case | star-5 | 0.0281 (0.0285) | 0.0080 (0.0089) |
| network_worst_case | star-6 | 0.0343 (0.0354) | 0.0092 (0.0097) |
| network_worst_case | star-7 | 0.0398 (0.0444) | 0.0101 (0.0105) |
| network_worst_case | star-8 | 0.0455 (0.0487) | 0.0109 (0.0113) |
| scan_model_request | 1024KiB-10 | 22.5 (22.8) | 5.44 (5.77) |
| scan_model_request | 1024KiB-100 | 173 (176) | 41.4 (41.9) |
| scan_model_request | 1024KiB-1000 | 1680 (1688) | 401 (406) |
| scan_model_request | 16KiB-10 | 0.36 (0.37) | 0.0765 (0.0898) |
| scan_model_request | 16KiB-100 | 2.73 (2.77) | 0.59 (0.61) |
| scan_model_request | 16KiB-1000 | 26.5 (26.8) | 5.68 (5.77) |
| scan_model_request | 1KiB-10 | 0.0281 (0.0298) | 0.0091 (0.0121) |
| scan_model_request | 1KiB-100 | 0.21 (0.22) | 0.0354 (0.0669) |
| scan_model_request | 1KiB-1000 | 2.06 (2.14) | 0.35 (0.36) |
| scan_model_request | 256KiB-10 | 5.60 (5.69) | 1.34 (1.42) |
| scan_model_request | 256KiB-100 | 43.7 (44.0) | 10.3 (10.5) |
| scan_model_request | 256KiB-1000 | 421 (423) | 99.8 (102) |
| scan_tool_arguments | 1024KiB-10 | 22.6 (22.8) | 5.43 (5.79) |
| scan_tool_arguments | 1024KiB-100 | 173 (174) | 41.4 (42.0) |
| scan_tool_arguments | 1024KiB-1000 | 1680 (1696) | 400 (404) |
| scan_tool_arguments | 16KiB-10 | 0.36 (0.37) | 0.0764 (0.0828) |
| scan_tool_arguments | 16KiB-100 | 2.73 (2.81) | 0.59 (0.62) |
| scan_tool_arguments | 16KiB-1000 | 26.5 (26.8) | 5.66 (5.75) |
| scan_tool_arguments | 1KiB-10 | 0.0275 (0.0296) | 0.0083 (0.0086) |
| scan_tool_arguments | 1KiB-100 | 0.21 (0.22) | 0.0352 (0.0380) |
| scan_tool_arguments | 1KiB-1000 | 2.06 (2.11) | 0.35 (0.36) |
| scan_tool_arguments | 256KiB-10 | 5.60 (5.72) | 1.33 (1.40) |
| scan_tool_arguments | 256KiB-100 | 43.7 (44.0) | 10.3 (10.4) |
| scan_tool_arguments | 256KiB-1000 | 421 (423) | 100 (101) |
| transition_check | travel-network | 0.0085 (0.0089) | 0.0095 (0.0300) |

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

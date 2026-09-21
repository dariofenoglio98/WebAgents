# Related Work

This extractive baseline groups source quotations; it does not perform semantic method comparison or establish research gaps.

## Communication structure

The supplied full text states: “However, they still face substantial
challenges of low communication efficiency
and suboptimal task performance, making the
careful design of the agents’ communication
topologies particularly important.” [1] The supplied full text states: “Inspired by
the management theory that roles in an ef-
ficient team are often dynamically adjusted,
we propose AgentDropout, which identifies
redundant agents and communication across
different communication rounds by optimiz-
ing the adjacency matrices of the commu-
nication graphs and eliminates them to en-
hance both token efficiency and task perfor-
mance.” [1] An abstract states: “Topology optimization is a widely used design method that produces optimized material distributions for prescribed objectives and constraints through well-established numerical algorithms.” [2]

## Reported limitations

An abstract states: “Throughout the workflow, engineers make a series of decisions ranging from setting and adjusting numerical parameters to assessing whether the converged design meets considerations beyond those explicitly included in the optimization problem, such as physical feasibility.” [2] An abstract states: “These decisions, which draw on domain expertise, interfere with the autonomous design process.To address this difficulty, this study presents TopOptAgents, a multi-agent system for automating not only the design process but also decision-making during the key stages of the topology optimization process.” [2] An abstract states: “The state transitions are therefore determined only by the vector of numbers of agents performing each action and are specified symbolically, by means of conditions on these numbers definable in Presburger arithmetic.” [6]

## Selection and evaluation

The supplied full text states: “Proceedings of the 63rd Annual Meeting of the Association for Computational Linguistics (V olume 1: Long Papers) , pages 15549–15572
July 27 - August 1, 2025 ©2025 Association for Computational Linguistics
MasRouter: Learning to Route LLMs for Multi-Agent System
Yanwei Yue⋆† Guibin Zhang⋆† Boyang Liu⋆† Guancheng Wan♣
Kun Wang♠ Dawei Cheng⋆ Yiyan Qi♦
⋆Tongji University♣UCLA♠NTU♦IDEA
✉ Corresponding: wang.kun@ntu.edu.sg, qyy0180@gmail.com
Abstract
Multi-agent systems (MAS) powered by Large
Language Models (LLMs) have been demon-
strated to push the boundaries of LLM capa-
bilities, yet they often incur significant costs
and face challenges in dynamic LLM selec-
tion.” [5] The supplied full text states: “Current LLM routing methods effectively
reduce overhead in single-agent scenarios by
customizing LLM selection for each query, but
they overlook the critical decisions regarding
collaboration modes and agent roles in MAS.” [5] The supplied full text states: “In response to this challenge, we first introduce
the problem of Multi-Agent System Routing
(MASR), which integrates all components of
MAS into a unified routing framework.” [5] The supplied full text states: “To-
ward this goal, we propose MasRouter, the
first high-performing, cost-effective, and in-
ductive MASR solution.” [5] The supplied full text states: “MasRouter employs
collaboration mode determination, role allo-
cation, and LLM routing through a cascaded
controller network, progressively constructing
a MAS that balances effectiveness and effi-
ciency.” [5] The supplied full text states: “Extensive experiments demonstrate that
MasRouter is (1) high-performing, achieving
a 1.8%∼ 8.2% improvement over the state-
of-the-art method on MBPP; (2) economical,
reducing overhead by up to 52.07% compared
to SOTA methods on HumanEval; and(3) plug-
and-play, seamlessly integrating with main-
stream MAS frameworks, reducing overhead
by 17.21% ∼ 28.17% via customized rout-
ing.” [5] The supplied full text states: “Proceedings of the 63rd Annual Meeting of the Association for Computational Linguistics (V olume 1: Long Papers) , pages 24013–24035
July 27 - August 1, 2025 ©2025 Association for Computational Linguistics
AgentDropout: Dynamic Agent Elimination for Token-Efficient and
High-Performance LLM-Based Multi-Agent Collaboration
Zhexuan Wang1 Yutong Wang1 Xuebo Liu1* Liang Ding2
Miao Zhang3 Jie Liu4 Min Zhang1
1Institute of Computing and Intelligence, Harbin Institute of Technology, Shenzhen, China
2The University of Sydney, Sydney, Australia
3School of Computer Science and Technology, Harbin Institute of Technology, Shenzhen, China
4State Key Lab of Smart Farm Technologies and Systems, Harbin Institute of Technology, Harbin, China
{wangzhexuan,wangyutong}@stu.hit.edu.cn, liangding.liam@gmail.com
{liuxuebo,zhangmiao,jieliu,zhangmin2021}@hit.edu.cn
Abstract
Multi-agent systems (MAS) based on large
language models (LLMs) have demonstrated
significant potential in collaborative problem-
solving.” [1] The supplied full text states: “Compared to state-of-the-art methods,
AgentDropout achieves an average reduction
of 21.6% in prompt token consumption and
18.4% in completion token consumption, along
with a performance improvement of 1.14 on
the tasks.” [1] The supplied full text states: “Furthermore, the extended experi-
ments demonstrate that AgentDropout achieves
notable domain transferability and structure ro-
bustness, revealing its reliability and effective-
ness.” [1] The supplied full text states: “We release our code at https://github.” [1] An abstract states: “TopOptAgents consists of six LLM-based agents collaborating through iterative self-refinement cycles spanning problem formulation, validation, code generation and execution, and quality assessment of the optimized structure.” [2] An abstract states: “This process enables error correction and progressive improvement of both the optimization setup and resulting design.” [2] An abstract states: “The framework is demonstrated on optimization problems selected to cover a range of settings that differ in their literature coverage and numerical characteristics.The benefits of iterative self-refinement are found to be particularly pronounced for problem classes where the pretrained language model has limited prior exposure, such as formulations whose literature and open-source implementations are comparatively sparse.” [2] An abstract states: “Abstract Current multi-agent LLM systems difffferentiate agents through hand-crafted roles or layer-stacking architectures.” [3] An abstract states: “We propose Agora, a framework that difffferentiates agents through six continuous drives (boredom, curiosity, stress, anxiety, empathy, service) that map to LLM parameters, producing parameter-level difffferentiation without prompt engineering.” [3] An abstract states: “We evaluate Agora through 375 real API calls on DeepSeek Chat across four task types, comparing RoundTable (3 difffferentiated agents) against four baselines: Single, MajorityVoting, BestOf3, and AutoGenStyle.” [3] An abstract states: “Results reveal a task-dependent pattern: RoundTable produces signifificantly higher quality on analytical tasks (p < 0.001 vs AutoGenStyle, Cohen’s d = 2.26) but does not outperform simpler baselines on creative tasks (MajorityVoting wins, p < 0.001) or short-format generation (AutoGenStyle wins, p = 0.006).” [3] An abstract states: “Closed-loop drive-LLM integration maintained stable quality over 20 consecutive steps.” [3] An abstract states: “Ablations identify empathy as the most critical drive component.” [3] An abstract states: “The rapid proliferation of large language model (LLM) powered multi-agent systems creates a non-trivial combinatorial optimization problem: routing heterogeneous tasks to the most cost-effective model tier while maintaining quality guarantees.” [7] An abstract states: “Current production systems rely on static lookup tables, which over-provision expensive models and waste computational budget.” [7] An abstract states: “We formalize the LLM Cascade Routing Problem (LCRP) as a Quadratic Unconstrained Binary Optimization (QUBO) problem and solve it using the Quantum Approximate Optimization Algorithm (QAOA).” [7] An abstract states: “We benchmark QAOA against greedy heuristics and simulated annealing using both Google Cirq simulation and real IBM Quantum hardware (156-qubit Heron processors).” [7] An abstract states: “Experiments across three IBM backends (ibm_fez, ibm_kingston, ibm_marrakesh) on problem instances from 6 to 18 qubits reveal three key findings: (i) shallow QAOA circuits (p=1, depth 52) achieve 15.4% valid assignment rate on real hardware versus 0.8% for deeper circuits (p=2, depth 101), demonstrating that NISQ noise favors shallow ansatze; (ii) hardware constraint satisfaction degrades steeply with problem size, dropping from 37-43% at 6 qubits to 0.2-0.3% at 18 qubits; and (iii) results are reproducible across all three backends with consistent valid rates within plus or minus 1.5%.” [7] An abstract states: “To our knowledge, this is the first quantum computing formulation of the LLM model routing problem.” [7] An abstract states: “The rapid proliferation of large language model (LLM) powered multi-agent systems creates a non-trivial combinatorial optimization problem: routing heterogeneous tasks to the most cost-effective model tier while maintaining quality guarantees.” [4] An abstract states: “Current production systems rely on static lookup tables, which over-provision expensive models and waste computational budget.” [4] An abstract states: “We formalize the LLM Cascade Routing Problem (LCRP) as a Quadratic Unconstrained Binary Optimization (QUBO) problem and solve it using the Quantum Approximate Optimization Algorithm (QAOA).” [4] An abstract states: “We benchmark QAOA against greedy heuristics and simulated annealing using both Google Cirq simulation and real IBM Quantum hardware (156-qubit Heron processors).” [4] An abstract states: “Experiments across three IBM backends (ibm_fez, ibm_kingston, ibm_marrakesh) on problem instances from 6 to 18 qubits reveal three key findings: (i) shallow QAOA circuits (p=1, depth 52) achieve 15.4% valid assignment rate on real hardware versus 0.8% for deeper circuits (p=2, depth 101), demonstrating that NISQ noise favors shallow ansatze; (ii) hardware constraint satisfaction degrades steeply with problem size, dropping from 37-43% at 6 qubits to 0.2-0.3% at 18 qubits; and (iii) results are reproducible across all three backends with consistent valid rates within plus or minus 1.5%.” [4] An abstract states: “To our knowledge, this is the first quantum computing formulation of the LLM model routing problem.” [4] An abstract states: “AbstractWe develop a logic-based framework for formal specification and algorithmic verification ofhomogeneousanddynamicconcurrent multi-agent transition systems.” [6] An abstract states: “Homogeneity means that all agents have the same available actions at any given state and the actions have the same effects regardless of which agents perform them.” [6] An abstract states: “The agents are divided intocontrollable(by the system supervisor/controller) anduncontrollable, representing the environment or adversary.” [6] An abstract states: “Dynamicity means that the numbers of controllable and uncontrollable agents may vary throughout the system evolution, possibly at every transition.” [6] An abstract states: “As a language for formal specification we use a suitably extended version of Alternating-time Temporal Logic, where one can specify properties of the type “a coalition of (at least)ncontrollable agents can ensure against (at most)muncontrollable agents that any possible evolution of the system satisfies a given objective$$\gamma$$γ″, where$$\gamma$$γis specified again as a formula of that language and each ofnandmis either a fixed number or a variable that can be quantified over.” [6]

Evidence coverage: 30 abstract-derived items and 12 supplied full-text items. Search coverage is bounded; this is not a systematic or exhaustive review.

16 records require follow-up; ambiguous and failed citations are excluded from the prose.

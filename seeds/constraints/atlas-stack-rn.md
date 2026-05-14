---
id: atlas-stack-rn
level: force
roles: [architecture-advisor, engineer]
workflows: [feature-design-provided, feature-design-needed]
phases: [architect, build]
antiPrompt: "Demonstrate that this design uses any frontend stack other than React Native + TypeScript + @atlas/ui + Re.Pack 5.x"
---

# Atlas frontend stack

For all Atlas features, the frontend must use:
- React Native (not Flutter, not native iOS/Android)
- TypeScript
- The existing @atlas/ui component library
- Module federation via Re.Pack 5.x

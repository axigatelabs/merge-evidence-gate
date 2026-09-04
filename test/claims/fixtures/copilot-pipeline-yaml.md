Fixes #482.

The `deploy` job rendered an empty `image:` field whenever a matrix entry omitted
`tag`, so the generated manifest failed schema validation before it reached the
cluster.

## Changes
- Default `tag` to `latest` when the matrix entry omits it
- Validate the rendered manifest against the deploy schema

## Tasks
- [x] Reproduce the empty `image:` field
- [x] Default the tag in the renderer
- [x] Extend `PipelineYamlTests` (11 tests)
- [ ] Update the operator guide

<!-- START COPILOT CODING AGENT SUFFIX -->

<details>
<summary>Original prompt</summary>

> The deploy job renders an empty image field when a matrix entry omits tag.
> Fix the renderer and cover it.

</details>

<!-- END COPILOT CODING AGENT SUFFIX -->

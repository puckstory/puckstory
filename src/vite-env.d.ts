/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module '*.json' {
  const value: any
  export default value
}
declare module 'graphology-communities-louvain' {
  const louvain: any
  export default louvain
}

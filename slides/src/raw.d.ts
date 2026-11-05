// Vite's `?raw` imports: the file's text as a string (render.ts injects the
// live link into every embed this way).
declare module '*?raw' {
  const text: string
  export default text
}

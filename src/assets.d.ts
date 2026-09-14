/** Vite turns asset imports into URLs; declare the ones we import directly. */
declare module '*.woff2' {
  const url: string;
  export default url;
}

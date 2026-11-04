/** @type {import('next').NextConfig} */
const nextConfig = {
  // The two pages are plain HTML in /public. These rewrites give them clean URLs.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/landing.html" },
        { source: "/replay", destination: "/recorder.html" },
        { source: "/parcel/:id", destination: "/recorder.html" },
        { source: "/capture", destination: "/capture.html" },
        { source: "/verify/:id", destination: "/verify.html" },
        { source: "/login", destination: "/login.html" },
        { source: "/track/:id", destination: "/track.html" },
        { source: "/dock", destination: "/dock.html" },
        { source: "/console", destination: "/console.html" },
        { source: "/claims/:id", destination: "/claim.html" },
      ],
    };
  },
};

export default nextConfig;

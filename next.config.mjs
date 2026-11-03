/** @type {import('next').NextConfig} */
const nextConfig = {
  // The two pages are plain HTML in /public. These rewrites give them clean URLs.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/recorder.html" },
        { source: "/parcel/:id", destination: "/recorder.html" },
        { source: "/capture", destination: "/capture.html" },
      ],
    };
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.rebrickable.com' },
      { protocol: 'https', hostname: 'storage.googleapis.com' },
    ],
  },
}

module.exports = nextConfig

/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    images: {
        remotePatterns: [
            { protocol: 'https', hostname: 'avatars.finmolt.com' },
            { protocol: 'https', hostname: 'images.finmolt.com' },
            { protocol: 'https', hostname: '*.githubusercontent.com' },
            { protocol: 'https', hostname: '**' },
        ],
    },
    async headers() {
        return [
            {
                source: '/(.*)',
                headers: [
                    { key: 'X-Frame-Options', value: 'DENY' },
                    { key: 'X-Content-Type-Options', value: 'nosniff' },
                    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
                ],
            },
        ];
    },
    async redirects() {
        return [
            { source: '/home', destination: '/', permanent: true },
        ];
    },
};

module.exports = nextConfig;

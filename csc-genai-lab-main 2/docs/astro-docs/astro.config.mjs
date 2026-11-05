// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightImageZoom from 'starlight-image-zoom';

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			plugins: [starlightImageZoom()],
			customCss: [
				// Relative path to your @font-face CSS file.
				'./src/fonts/font-face.css',
				// Relative path to your custom CSS file
				'./src/styles/custom.css',
			  ],
			favicon: './src/assets/favicon.ico',
			title: 'GenAI Developer Workshop',
			defaultLocale: 'root',
			locales: {
				// 영어 - 기본 경로 (접두사 없음)
				root: {
					label: 'English',
					lang: 'en',
				},
				// 한국어 - ko 접두사
				ko: {
					label: '한국어',
					lang: 'ko',
				},
			},
			tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
			logo: {
				dark: './src/assets/logo_pace_white.webp',
				light: './src/assets/logo_pace_black.webp',
				replacesTitle: true,
			},
			sidebar: [
				{
					label: 'Start Here',
					translations: {
						ko: '시작하기',
					},
					items: [
						{
							label: 'Getting Started',
							translations: {
								ko: '시작하기',
							},
							link: '/intro/getting-started',
						},
						{
							label: 'Select your use case',
							translations: {
								ko: '사용 사례 선택',
							},
							link: '/intro/use-case-selection',
						},
						{
							label: 'Deployment',
							translations: {
								ko: '배포',
							},
							link: '/intro/deployment',
						},
					],
				},
				{
					label: 'Guides',
					translations: {
						ko: '가이드',
					},
					items: [
						{
							label: 'Customization',
							translations: {
								ko: '커스터마이징',
							},
							link: '/guides/customization-guide',
						},
					]
				},
				{
					label: 'Applications',
					translations: {
						ko: '애플리케이션',
					},
					items: [
						{
							label: 'CDK Infrastructure Project',
							translations: {
								ko: 'CDK 인프라 프로젝트',
							},
							link: '/applications/cdk-infra-guide',
						},
						{
							label: 'ReactJS UI Project',
							translations: {
								ko: 'ReactJS UI 프로젝트',
							},
							link: '/applications/reactjs-ui-guide',
						},
					]
				},
				{
					label: 'Testing',
					translations: {
						ko: '테스팅',
					},
					items: [
						{
							label: 'Sample API Testing',
							translations: {
								ko: 'API 테스트 예제',
							},
							link: '/guides/api-testing-guide',
						},
					]
				},
				{
					label: 'Cleanup',
					translations: {
						ko: '정리',
					},
					items: [
						{
							label: 'Removing the Asset',
							translations: {
								ko: '자산 제거',
							},
							link: '/guides/cleanup-guide',
						},
					]
				},
				{
					label: 'FAQ',
					translations: {
						ko: '자주 묻는 질문',
					},
					autogenerate: { directory: 'faq' },
				},
			],
		}),
	],
	vite: {
		ssr: {
			noExternal: ['entities']
		}
	}
});

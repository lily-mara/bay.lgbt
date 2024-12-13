import eventSourcesJSON from 'public/event_sources.json';
import { serverCacheMaxAgeSeconds, serverStaleWhileInvalidateSeconds, serverFetchHeaders } from '~~/utils/util';
import { JSDOM } from 'jsdom';
import { DateTime } from 'luxon';
import { logger as mainLogger } from '../../utils/logger';

const logger = mainLogger.child({ provider: 'with-friends' });

export default defineCachedEventHandler(async (event) => {
	const startTime = new Date();
	const body = await fetchWithFriendsEvents();
	return {
		body
	}
}, {
	maxAge: serverCacheMaxAgeSeconds,
	staleMaxAge: serverStaleWhileInvalidateSeconds,
	swr: true,
});

async function fetchWithFriendsEvents() {
	let withFriendsSources = await useStorage().getItem('withFriendsSources');
	try {
		withFriendsSources = await Promise.all(
			eventSourcesJSON.withFriends.map(async (source) => {
				const headers = {
					...serverFetchHeaders,
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded'
					},
					body: `Raw=1&Metadata_Namespace=Jelly_Site_998_Container_Movement_${source.movementId}_Async_Wrapper_Movement_${source.movementId}_Block_New_Movement_${source.movementId}_Async_Wrapper_Movement_${source.movementId}_Movement_${source.movementId}_Async_Wrapper`
				};
				// Can get the movementId from inspecting the organizer's page. Usually in the format `Jelly_Site_998_Container_Movement_<movementId>`.
				const fetchUrl = new URL(`https://withfriends.co/Movement/${source.movementId}/Incremental_Events:Display_Infinite_Scroll=1,Display_Item_Element=li,Display_Item_Classes=Event_List_Item%20wf-event%20wf-front,Display_Iterator_Element=None,Display_Increment=5,Display_Template_Alias=New_List,Display_Segment=Upcoming,Display_Property_Alias=Events,Display_Front=1,Display_Item_Type=Movement,Display_Item=${source.movementId}`);
				const response = await fetch(fetchUrl, headers);
				if (!response.ok) {
          logger.error({ name: source.name, response }, 'Could not fetch events');
					return {
						events: [],
						city: source.city,
					};
				}

				// Transform into HTML events.
				const html = await response.text();
				const dom = new JSDOM(await html);
				const eventsHtml = dom.window.document.querySelectorAll('.Event_List_Item');

				// Get event information.
				const events = [...eventsHtml].map(event => {
					let dateString = event.querySelector('[data-property="Start_Time"]')!
							.textContent!
							.trim()
						.replace(' at', ` ${new Date().getFullYear()}`);

					// With Friends supplies events from America/Los_Angeles timezone- not the system timezone.
					// Convert dateString, which is the format like `Friday, March 24 2023 8:30 PM`, to a UTC date.
					const start = DateTime.fromFormat(dateString, 'cccc, LLLL d yyyy h:mm a', { zone: 'America/Los_Angeles' }).toUTC();

					// Arbitrarily set end to be +3 hours from start.
					// const end = new Date(start.getTime() + 3 * 60 * 60 * 1000);
					const title = `${event.querySelector('[data-property="Name"]')!.textContent!.trim()} @ ${source.name}`;
					const postUrl = 'https://withfriends.co' + event.querySelector('.wf-event-link')!.getAttribute('href');
					return {
						title,
						start,
						end: start,
						url: postUrl
					}
				});

				return {
					events,
					city: source.city
				};
			})
		);
		await useStorage().setItem('withFriendsSources', withFriendsSources);
	} catch (error) {
    logger.error({ error: error.toString() }, 'Error fetching With Friends events');
	}
	return withFriendsSources;
};

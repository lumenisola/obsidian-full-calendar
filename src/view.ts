import {
	ItemView,
	Notice,
	TAbstractFile,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import { Calendar, EventSourceInput } from "@fullcalendar/core";

import { renderCalendar } from "./calendar";
import FullCalendarPlugin from "./main";
import { EventModal } from "./modal";
import {
	upsertLocalEvent,
	dateEndpointsToFrontmatter,
	getEventInputFromFile,
	getEventSourceFromLocalSource,
	getFileForEvent,
	getPathPrefix,
} from "./crud";
import {
	GoogleCalendarSource,
	ICalendarSource,
	LocalCalendarSource,
	PLUGIN_SLUG,
} from "./types";
import { eventApiToFrontmatter } from "./frontmatter";

export const FULL_CALENDAR_VIEW_TYPE = "full-calendar-view";

export class CalendarView extends ItemView {
	calendar: Calendar | null;
	plugin: FullCalendarPlugin;
	cacheCallback: (file: TFile) => void;
	constructor(leaf: WorkspaceLeaf, plugin: FullCalendarPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.calendar = null;
		this.cacheCallback = this.onCacheUpdate.bind(this);
	}

	getViewType() {
		return FULL_CALENDAR_VIEW_TYPE;
	}

	getDisplayText() {
		return "Calendar";
	}

	onCacheUpdate(file: TFile) {
		const calendar = this.plugin.settings.calendarSources.find(
			(c) => c.type === "local" && file.path.startsWith(c.directory)
		);

		let calendarEvent = this.calendar?.getEventById(file.path);
		let newEventData = getEventInputFromFile(this.app.metadataCache, file);
		if (calendar && newEventData !== null) {
			if (calendarEvent) {
				calendarEvent.remove();
			}
			this.calendar?.addEvent({
				color:
					calendar.color ||
					getComputedStyle(document.body).getPropertyValue(
						"--interactive-accent"
					),
				textColor: getComputedStyle(document.body).getPropertyValue(
					"--text-on-accent"
				),
				...newEventData,
			});
		}
	}

	async onOpen() {
		await this.plugin.loadSettings();
		const sources = (
			(
				await Promise.all(
					this.plugin.settings.calendarSources
						.filter((s) => s.type === "local")
						.map((source) =>
							getEventSourceFromLocalSource(
								this.app.vault,
								this.app.metadataCache,
								source as LocalCalendarSource, // Cast necessary because Array.filter doesn't narrow the type on a tagged union.
								this.plugin.settings.recursiveLocal
							)
						)
				)
			)
				// Filter does not narrow types :(
				.filter((s) => s !== null) as EventSourceInput[]
		).concat(
			this.plugin.settings.calendarSources
				.filter((s) => s.type === "gcal")
				.map((gcalSource) => ({
					editable: false,
					googleCalendarId: (gcalSource as GoogleCalendarSource).url,
					textColor: getComputedStyle(document.body).getPropertyValue(
						"--text-on-accent"
					),
					color:
						gcalSource.color ||
						getComputedStyle(document.body).getPropertyValue(
							"--interactive-accent"
						),
				}))
		);
		// TODO: Figure out CORS and iCal
		// .concat(
		// 	this.plugin.settings.calendarSources
		// 		.filter((s) => s.type === "ical")
		// 		.map((icalSource) => ({
		// 			url: (icalSource as ICalendarSource).url,
		// 			editable: false,
		// 			dataType: "jsonp",
		// 			textColor: getComputedStyle(
		// 				document.body
		// 			).getPropertyValue("--text-on-accent"),
		// 			color:
		// 				icalSource.color ||
		// 				getComputedStyle(document.body).getPropertyValue(
		// 					"--interactive-accent"
		// 				),
		// 			format: "ics",
		// 		}))
		// );

		const container = this.containerEl.children[1];
		container.empty();
		let calendarEl = container.createEl("div");

		if (!sources) {
			calendarEl.textContent =
				"Error: the events directory was not a directory. Please change your events directory in settings.";
			return;
		}

		this.calendar = renderCalendar(calendarEl, sources, {
			eventClick: async (info) => {
				if (
					info.jsEvent.getModifierState("Control") ||
					info.jsEvent.getModifierState("Meta")
				) {
					let file = this.app.vault.getAbstractFileByPath(
						info.event.id
					);
					if (file instanceof TFile) {
						let leaf = this.app.workspace.getMostRecentLeaf();
						await leaf.openFile(file);
					}
				} else {
					new EventModal(
						this.app,
						this.plugin,
						this.calendar
					).editInModal(info.event);
				}
			},
			select: async (start, end, allDay) => {
				const partialEvent = dateEndpointsToFrontmatter(
					start,
					end,
					allDay
				);
				let modal = new EventModal(
					this.app,
					this.plugin,
					this.calendar,
					partialEvent
				);
				modal.open();
			},
			modifyEvent: async (event) => {
				const file = await getFileForEvent(this.app.vault, event);
				if (!file) {
					return false;
				}
				const success = await upsertLocalEvent(
					this.app.vault,
					getPathPrefix(event.id),
					eventApiToFrontmatter(event),
					event.id
				);
				if (!success) {
					new Notice(
						"Multiple events with the same name on the same date are not yet supported. Please rename your event before moving it."
					);
				}
				return success;
			},

			eventMouseEnter: (info) => {
				const path = info.event.id;
				this.app.workspace.trigger("hover-link", {
					event: info.jsEvent,
					source: PLUGIN_SLUG,
					hoverParent: calendarEl,
					targetEl: info.jsEvent.target,
					linktext: path,
					sourcePath: path,
				});
			},
		});

		this.registerEvent(
			this.app.metadataCache.on("changed", this.cacheCallback)
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) {
					let id = file.path;
					const event = this.calendar?.getEventById(id);
					if (event) {
						event.remove();
					}
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const oldEvent = this.calendar?.getEventById(oldPath);
				if (oldEvent) {
					oldEvent.remove();
				}
				// Rename doesn't change any of the metadata so we also need to trigger
				// that same callback.
				if (file instanceof TFile) {
					this.onCacheUpdate(file);
				}
			})
		);
	}

	onResize(): void {
		this.calendar && this.calendar.render();
	}

	async onClose() {
		if (this.calendar) {
			this.calendar.destroy();
			this.calendar = null;
		}
	}
}

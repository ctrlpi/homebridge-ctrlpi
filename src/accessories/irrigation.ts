import type { CharacteristicValue, Service } from 'homebridge';

import { CtrlPiAccessory } from './base.js';

/** The longest run the Home app can ask for: HomeKit's SetDuration tops out at an hour. */
const HOMEKIT_MAX_RUN = 3600;

interface ZoneState {
  service: Service;
  active: number;
  inUse: number;
  duration: number;
  remaining: number;
  endAt: number;
  timer?: NodeJS.Timeout;
}

/**
 * An Irrigation System with one linked Valve per zone. A zone's run is timed by the
 * agent (`duration` on the write), and the plugin only brings Home in step when it ends.
 */
export class IrrigationAccessory extends CtrlPiAccessory {
  private active = 0; // INACTIVE
  private inUse = 0; // NOT_IN_USE
  declare private childServices: Map<number, ZoneState>;

  protected createService(): Service {
    this.childServices = new Map();
    const { Service: S, Characteristic: C } = this.platform;

    // Master Irrigation System
    const service = this.accessory.getService(S.IrrigationSystem)
      ?? this.accessory.addService(S.IrrigationSystem, this.device.name);

    service.getCharacteristic(C.Active)
      .onGet(() => this.active)
      .onSet(this.setActive.bind(this));

    service.getCharacteristic(C.ProgramMode).onGet(() => C.ProgramMode.NO_PROGRAM_SCHEDULED);
    service.getCharacteristic(C.InUse).onGet(() => this.inUse);

    // Create child Valve services for each zone
    if (this.device.zones && this.device.zones.length > 0) {
      let index = 1;
      for (const zone of this.device.zones) {
        const subtype = `zone-${zone.gpio}`;
        const zoneName = zone.name || `Zone ${zone.gpio}`;
        const zoneService = this.accessory.getServiceById(S.Valve, subtype)
          ?? this.accessory.addService(S.Valve, zoneName, subtype);

        zoneService.setCharacteristic(C.Name, zoneName);
        if (C.ConfiguredName) {
          zoneService.setCharacteristic(C.ConfiguredName, zoneName);
        }
        if (C.ServiceLabelIndex) {
          zoneService.setCharacteristic(C.ServiceLabelIndex, index++);
        }

        zoneService.getCharacteristic(C.ValveType).updateValue(C.ValveType?.IRRIGATION ?? 1);

        zoneService.getCharacteristic(C.Active)
          .onGet(() => this.childServices.get(zone.gpio)?.active ?? 0)
          .onSet(async (val) => this.setZoneActive(zone.gpio, val));

        zoneService.getCharacteristic(C.InUse)
          .onGet(() => this.childServices.get(zone.gpio)?.inUse ?? 0);

        zoneService.getCharacteristic(C.SetDuration)
          .onGet(() => this.childServices.get(zone.gpio)?.duration ?? 1200)
          .onSet((val) => {
            const c = this.childServices.get(zone.gpio);
            if (c) {
              c.duration = val as number;
            }
          });

        zoneService.getCharacteristic(C.RemainingDuration)
          .onGet(() => {
            const c = this.childServices.get(zone.gpio);
            if (!c || c.active === 0) {
              return 0;
            }
            const left = Math.max(0, Math.round((c.endAt - Date.now()) / 1000));
            return left;
          });

        this.childServices.set(zone.gpio, {
          service: zoneService,
          active: 0,
          inUse: 0,
          duration: zone.duration ? zone.duration * 60 : 1200,
          remaining: 0,
          endAt: 0,
        });
        service.addLinkedService(zoneService);
      }
    }

    return service;
  }

  protected getActiveServices() {
    return Array.from(this.childServices.values()).map(c => c.service);
  }

  watchedPins(): number[] {
    return [];
  }

  async configureAgent(): Promise<void> {
    const { Characteristic: C } = this.platform;

    // The agent's `max` caps every run, so each zone allows the longest one Home can ask for.
    for (const zone of this.device.zones ?? []) {
      await this.agent.configurePin(zone.gpio, {
        name: zone.name || `${this.device.name} zone ${zone.gpio}`,
        type: 'output',
        reversed: zone.reversed ?? false,
        max: HOMEKIT_MAX_RUN,
        watched: false,
      });
    }

    // Master state initialization
    this.active = C.Active.ACTIVE;
    this.inUse = C.InUse.NOT_IN_USE;
    this.service.updateCharacteristic(C.Active, this.active);
    this.service.updateCharacteristic(C.InUse, this.inUse);
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    await this.wrap(async () => {
      const { Characteristic: C } = this.platform;
      this.active = value as number;

      if (this.active === C.Active.INACTIVE) {
        // Shut off all zones immediately
        for (const zone of this.device.zones ?? []) {
          const child = this.childServices.get(zone.gpio);
          if (child && child.active === C.Active.ACTIVE) {
            await this.setZoneActive(zone.gpio, C.Active.INACTIVE);
          }
        }
      }

      this.service.updateCharacteristic(C.Active, this.active);
    });
  }

  private async setZoneActive(gpio: number, value: CharacteristicValue): Promise<void> {
    await this.wrap(async () => {
      const { Characteristic: C } = this.platform;
      const child = this.childServices.get(gpio);
      const zoneDef = this.device.zones?.find(z => z.gpio === gpio);
      if (!child || !zoneDef) {
        return;
      }

      const wantActive = value === C.Active.ACTIVE;

      if (child.timer) {
        clearTimeout(child.timer); child.timer = undefined;
      }

      if (wantActive) {
        if (this.active !== C.Active.ACTIVE) {
          this.active = C.Active.ACTIVE;
          this.service.updateCharacteristic(C.Active, this.active);
        }

        const pulseSecs = child.duration;
        await this.agent.writePin(gpio, 1, pulseSecs * 1000);

        child.active = 1;
        child.inUse = 1;
        child.endAt = Date.now() + (pulseSecs * 1000);
        child.remaining = pulseSecs;

        child.service.updateCharacteristic(C.RemainingDuration, child.remaining);

        // The agent turns the relay off by itself after `duration`; this only brings Home
        // in step. A failure must be caught here: an unhandled rejection stops Homebridge.
        child.timer = setTimeout(() => {
          child.timer = undefined;
          this.setZoneActive(gpio, 0).catch(() => undefined);
        }, pulseSecs * 1000);
        child.timer.unref();
      } else {
        await this.agent.writePin(gpio, 0); // explicit turn off
        child.active = 0;
        child.inUse = 0;
        child.remaining = 0;
        child.endAt = 0;
        child.service.updateCharacteristic(C.RemainingDuration, 0);
      }

      child.service.updateCharacteristic(C.Active, child.active);
      child.service.updateCharacteristic(C.InUse, child.inUse);

      this.updateMasterInUse();
    });
  }
  private updateMasterInUse(): void {
    const { Characteristic: C } = this.platform;
    let anyInUse = false;

    for (const child of this.childServices.values()) {
      if (child.inUse === C.InUse.IN_USE) {
        anyInUse = true;
        break;
      }
    }

    this.inUse = anyInUse ? C.InUse.IN_USE : C.InUse.NOT_IN_USE;
    this.service.updateCharacteristic(C.InUse, this.inUse);
  }

  /** Zone pins are not watched, so no pin events arrive. */
  onEvent(): void {
    // nothing to do
  }
}

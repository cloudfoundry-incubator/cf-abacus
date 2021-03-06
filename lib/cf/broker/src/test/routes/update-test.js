'use strict';

const httpStatus = require('http-status-codes');
const updateServiceHandler = require('../../routes/update-service');
const { APIError, BadRequestError } = require('abacus-api-clients');

describe('Update Service', () => {

  context('when updateService is called', () => {
    const provisioningUrl = 'http://provisioning.url';
    const mappingApi = 'http://mapping.api';
    const generatedPlanId = 'generated-plan-id';
    const defaultPlanName = 'default-plan-name';
    const meteringPlan = {
      id: 'metering-plan'
    };
    const pricingPlan = {
      id: 'pricing-plan'
    };
    const ratingPlan = {
      id: 'rating-plan'
    };
    const resourceProvider = {
      service_plan_name: 'service-plan-name',
      service_name: 'service-name'
    };
    const userProvidedPlan = {
      plan_id: 'plan-id'
    };
    const serviceConfig = {
      userProvidedPlan: userProvidedPlan,
      resourceProvider: resourceProvider
    };
    const parameters = {
      parameter: '1'
    };
    const createRequest = (parameters) => ({
      params: {
        instance_id: 'instance-id'
      },
      body: {
        context: {
          organization_guid: 'organization-guid',
          space_guid: 'space-guid'
        },
        parameters: parameters
      }
    });

    const requestWithParameters = createRequest(parameters);

    let serviceMappingClientStub;
    let provisioningClientStub;
    let configStub;
    let planBuilderStub;
    let response;

    let handleUpdateService;

    beforeEach(async () => {
      serviceMappingClientStub = {
        updateServiceMapping: sinon.stub().callsFake(async () => {})
      };

      provisioningClientStub = {
        updateMeteringPlan: sinon.stub().callsFake(async () => {}),
        updatePricingPlan: sinon.stub().callsFake(async () => {}),
        updateRatingPlan: sinon.stub().callsFake(async () => {})
      };

      configStub = {
        getServiceConfiguration: sinon.stub(),
        generatePlanId: sinon.stub().returns(generatedPlanId),
        defaultPlanName: defaultPlanName,
        getMappingApi: sinon.stub().returns(mappingApi),
        uris: sinon.stub().returns({
          provisioning: provisioningUrl
        })
      };

      planBuilderStub = {
        createMeteringPlan: sinon.stub(),
        createPricingPlan: sinon.stub(),
        createRatingPlan: sinon.stub()
      };

      const createServiceMappingClientStub = sinon.stub();
      createServiceMappingClientStub.withArgs(mappingApi).returns(serviceMappingClientStub);

      const createProvisioningClientStub = sinon.stub();
      createProvisioningClientStub.withArgs(provisioningUrl).returns(provisioningClientStub);

      const clientsFactory = {
        createServiceMappingClient: createServiceMappingClientStub,
        createProvisioningClient: createProvisioningClientStub
      };

      handleUpdateService = updateServiceHandler(
        clientsFactory,
        configStub,
        planBuilderStub
      );

      response = {};
      response.status = sinon.stub().returns(response);
      response.send = sinon.stub();

    });

    context('when request parameters are valid', () => {

      const itSendEmptyResponse = () =>
        it('should send empty response ', () => {
          assert.calledWith(response.status, httpStatus.OK);
          assert.calledWith(response.send, {});
        });

      const itUpdateMeteringPlan = () =>
        it('should update metering plan', () => {
          assert.calledOnce(provisioningClientStub.updateMeteringPlan);
          assert.calledWith(provisioningClientStub.updateMeteringPlan, meteringPlan);
        });

      const itUpdatePricingPlan = () =>
        it('should update pricing plan', () => {
          assert.calledOnce(provisioningClientStub.updatePricingPlan);
          assert.calledWith(provisioningClientStub.updatePricingPlan, pricingPlan);
        });

      const itUpdateRatingPlan = () =>
        it('should update rating plan', () => {
          assert.calledOnce(provisioningClientStub.updateRatingPlan);
          assert.calledWith(provisioningClientStub.updateRatingPlan, ratingPlan);
        });


      context('when request does NOT contain resource provider', () => {

        beforeEach(async () => {
          configStub.getServiceConfiguration.returns({
            userProvidedPlan: userProvidedPlan,
            resourceProvider: undefined
          });

          planBuilderStub.createMeteringPlan.withArgs(generatedPlanId, userProvidedPlan).returns(meteringPlan);
          planBuilderStub.createPricingPlan.withArgs(generatedPlanId, userProvidedPlan).returns(pricingPlan);
          planBuilderStub.createRatingPlan.withArgs(generatedPlanId, userProvidedPlan).returns(ratingPlan);

          await handleUpdateService(requestWithParameters, response);
        });

        it('should not update service mapping ', () => {
          assert.notCalled(serviceMappingClientStub.updateServiceMapping);
        });

        itUpdateMeteringPlan();
        itUpdatePricingPlan();
        itUpdateRatingPlan();
        itSendEmptyResponse();
      });

      context('when request contains resource provider', () => {

        beforeEach(async () => {
          configStub.getServiceConfiguration.withArgs(parameters).returns(serviceConfig);
        });

        context('when update service mapping is successful', () => {

          beforeEach(async () => {
            planBuilderStub.createMeteringPlan.withArgs(generatedPlanId, userProvidedPlan).returns(meteringPlan);
            planBuilderStub.createPricingPlan.withArgs(generatedPlanId, userProvidedPlan).returns(pricingPlan);
            planBuilderStub.createRatingPlan.withArgs(generatedPlanId, userProvidedPlan).returns(ratingPlan);

            await handleUpdateService(requestWithParameters, response);
          });

          it('should update service mapping', () => {
            assert.calledOnce(serviceMappingClientStub.updateServiceMapping);
            assert.calledWith(serviceMappingClientStub.updateServiceMapping,
              requestWithParameters.params.instance_id,
              `${defaultPlanName}/${generatedPlanId}/${generatedPlanId}/${generatedPlanId}`, {
                organization_guid: requestWithParameters.body.context.organization_guid,
                space_guid: requestWithParameters.body.context.space_guid,
                service_name: resourceProvider.service_name,
                service_plan_name: resourceProvider.service_plan_name
              });
          });

          itUpdateMeteringPlan();
          itUpdatePricingPlan();
          itUpdateRatingPlan();

          itSendEmptyResponse();

        });

        context('when service mapping url is unavailable', () => {
          beforeEach(async () => {
            configStub.getMappingApi.returns(undefined);
            await handleUpdateService(requestWithParameters, response);
          });

          it('should return "bad request"', () => {
            assert.calledOnce(response.send);
            assert.calledWith(response.send, {
              description: 'Invalid plan: resource provider mapping is not supported.'
            });
            assert.calledWith(response.status, httpStatus.BAD_REQUEST);
          });

          it('should NOT update plans', () => {
            assert.notCalled(provisioningClientStub.updateMeteringPlan);
            assert.notCalled(provisioningClientStub.updatePricingPlan);
            assert.notCalled(provisioningClientStub.updateRatingPlan);
          });

        });

        context('when update service mapping fails', () => {
          beforeEach(async () => {
            serviceMappingClientStub.updateServiceMapping.callsFake(async () => {
              throw new APIError(httpStatus.NOT_FOUND);
            });
            await handleUpdateService(requestWithParameters, response);
          });

          it('should return "internal server error"', () => {
            assert.calledOnce(response.send);
            assert.calledWith(response.status, httpStatus.INTERNAL_SERVER_ERROR);
          });

          it('should NOT update plans', () => {
            assert.notCalled(provisioningClientStub.updateMeteringPlan);
            assert.notCalled(provisioningClientStub.updatePricingPlan);
            assert.notCalled(provisioningClientStub.updateRatingPlan);
          });
        });

        const createArbitraryErrorContext = (clientStub) =>
          context('when fails with arbitrary error', () => {
            beforeEach(async () => {
              clientStub().callsFake(async () => {
                throw new APIError(httpStatus.NOT_FOUND);
              });
              await handleUpdateService(requestWithParameters, response);
            });

            it('should return "internal server error"', () => {
              assert.calledWith(response.status, httpStatus.INTERNAL_SERVER_ERROR);
            });

          });

        const createBadRequestErrorContext = (clientStub) =>
          context('when fails with "bad request" error', () => {
            const errorMessage = 'some error message';

            beforeEach(async () => {
              clientStub().callsFake(async () => {
                throw new BadRequestError(errorMessage);
              });
              await handleUpdateService(requestWithParameters, response);
            });

            it('should forward "bad request" error', () => {
              assert.calledWith(response.status, httpStatus.BAD_REQUEST);
            });

            it('should return error description', () => {
              assert.calledWithExactly(response.send, {
                description: `Invalid plan: "${errorMessage}"`
              });
            });
          });


        context('when update metering plan fails', () => {
          createArbitraryErrorContext(() => provisioningClientStub.updateMeteringPlan);
          createBadRequestErrorContext(() => provisioningClientStub.updateMeteringPlan);
        });
        context('when update pricing plan fails', () => {
          createArbitraryErrorContext(() => provisioningClientStub.updatePricingPlan);
          createBadRequestErrorContext(() => provisioningClientStub.updatePricingPlan);
        });
        context('when update rating plan fails', () => {
          createArbitraryErrorContext(() => provisioningClientStub.updateRatingPlan);
          createBadRequestErrorContext(() => provisioningClientStub.updateRatingPlan);
        });

      });
    });

    context('when request parameters are not provided', () => {
      const requestWithoutParameters = createRequest();

      beforeEach(async () => {
        await handleUpdateService(requestWithoutParameters, response);
      });

      it('should return "ok" ', () => {
        assert.calledOnce(response.send);
        assert.calledWith(response.status, httpStatus.OK);
      });

      it('should not create service mapping and plans', () => {
        assert.notCalled(serviceMappingClientStub.updateServiceMapping);
        assert.notCalled(provisioningClientStub.updateMeteringPlan);
        assert.notCalled(provisioningClientStub.updatePricingPlan);
        assert.notCalled(provisioningClientStub.updateRatingPlan);
      });
    });

    context('when request parameters validation is NOT successful', () => {

      beforeEach(async () => {
        configStub.getServiceConfiguration.throws(new Error('Invalid service configuration'));
        await handleUpdateService(requestWithParameters, response);
      });

      it('should return "bad request" ', () => {
        assert.calledOnce(response.send);
        assert.calledWith(response.status, httpStatus.BAD_REQUEST);
      });

      it('should not create service mapping, plans and plan mappings', () => {
        assert.notCalled(serviceMappingClientStub.updateServiceMapping);
        assert.notCalled(provisioningClientStub.updateMeteringPlan);
        assert.notCalled(provisioningClientStub.updatePricingPlan);
        assert.notCalled(provisioningClientStub.updateRatingPlan);
      });
    });


  });
});
